const deepMerge = require('deepmerge');
const ObjectId = require("mongoose").Types.ObjectId;

class Pagination {
  /**
   * Constructor.
   *
   * @param {Model} Model The Mongoose model to query against.
   * @param {object} params The criteria, pagination, and sort params.
   * @param {object} params.baseAggregationPipeline Base Aggregation Pipeline.
   * @param {object} params.pagination The pagination parameters.
   * @param {number} params.pagination.first The number of documents to return.
   *                                         Will default the the limit classes default.
   * @param {string} params.pagination.after The ID to start querying from.
   *                                         Should not be an obfuscated cursor value.
   * @param {object} params.sort The sort parameters
   * @param {string} params.sort.field The sort field name.
   * @param {string} params.sort.order The sort order. 1/-1.
   */
  constructor(Model, {
    baseAggregationPipeline = {},
    pagination = {},
    sort = {},
    filters = [],
    search = null,
  } = {}) {
    this.promises = {};

    // Set the Model to use for querying.
    this.Model = Model;

    // Set base aggregation pipeline.
    this.aggregationPipeline = baseAggregationPipeline.slice();

    // Search programmatically later (Azure Cosmos DB compatibility).
    this.search = search;

    this.pagination = pagination;

    for (let filter of filters) {
      this.aggregationPipeline.push(
        {
          $match: {
            [ filter.field ]: { $in: filter.value }
          },
        }
      );
    }

    // Set sorting.
    this.sort = sort;
    if (Boolean(sort.field) && Boolean(sort.order)) {
      this.aggregationPipeline.push(
        {
          $sort: {
            [sort.field]: sort.order
          }
        }
      );
    }
  }

  /**
   *
   * Filter Mongoose results that contains specified string
   * @param results     Mongoose results.
   * @param search      string to find (supports regex)
   * @param pagination  pagination object
   *
   * @return Mongoose results
   */
  filterResults(results, search, pagination) {
    let regex = new RegExp(search, 'i');
    let afterCursorModelCount = (Boolean(pagination) && Boolean(pagination.after)) ? -1 : 0;

    results = results.filter(function(result) {
      if (Boolean(pagination) && afterCursorModelCount == pagination.first) {
        return false;
      }
      if (Boolean(pagination) && Boolean(pagination.after) && afterCursorModelCount === -1) {
        if (result._id == pagination.after) {
          afterCursorModelCount += 1;
        }
        return false;
      }
      
      for (let value of Object.values(result)) {
        if (regex.exec(value)) {
          if (Boolean(pagination)) {
            afterCursorModelCount += 1;
          }
          return true;
        }
      }
      return false;
    });
    return results;
  }

  /**
   * Gets the total number of documents found.
   * Based on any initially set query criteria.
   *
   * @return {Promise}
   */
  getTotalCount() {
    const run = async () => {
      let aggregationPipelineNoPagination = this.aggregationPipeline.slice();
      if (Boolean(this.search)) {
        const results = await this.Model.aggregate(aggregationPipelineNoPagination);
        return this.filterResults(results, this.search).length;
      }
      aggregationPipelineNoPagination.push({
        $count: "count"
      });
      // remove $project pipeline to speed up little bit
      aggregationPipelineNoPagination = aggregationPipelineNoPagination.filter(a => Object.keys(a)[0] !== '$project' );
      
      const countResults = await this.Model.aggregate(aggregationPipelineNoPagination);
      const count = (countResults.length > 0) ? countResults[0]["count"] : 0;
      return count;
    };
    if (!this.promises.count) {
      this.promises.count = run();
    }
    return this.promises.count;
  }

  /**
   * @private
   * @param {string} id
   * @return {Promise}
   */
  findCursorModel(id) {
    const run = async () => {
      let aggregationPipelineFindOne = this.aggregationPipeline.slice();
      aggregationPipelineFindOne.unshift({
        $match: {
          _id: ObjectId(id)
        }
      });

      const results = await this.Model.aggregate(aggregationPipelineFindOne);
      if (results.length === 0) throw new Error(`No record found for ID '${id}'`);
      return results[0];
    };
    if (!this.promises.model) {
      this.promises.model = run();
    }
    return this.promises.model;
  }

  async aggregationAddPagination(aggregationPipeline, after) {
    let aggregationPipelineWithPagination = aggregationPipeline.slice();

    // Set after cursor.
    if (Boolean(after)) {
      const cursorModel = await this.findCursorModel(after);
      const orderDirection = this.sort.order == 1 ? '$gt' : '$lt';

      let ors = [];
      if (Boolean(this.sort.field) && Boolean(this.sort.order)) {
        ors.push({
          [ this.sort.field ]: { [ orderDirection ]: cursorModel[this.sort.field] }
        });
      }
      ors.push({
        _id: { $gt: ObjectId(after) }
      });
      aggregationPipelineWithPagination.push({
        $match: {
          $or: ors
        }
      });
    }

    // Set page limit (per page).
    this.perPage = this.pagination.first || 25;
    aggregationPipelineWithPagination.push({
      $limit: this.perPage
    });

    return aggregationPipelineWithPagination;
  }

  /**
   * Gets the document edges for the current limit and sort.
   *
   * @return {Promise}
   */
  getEdges() {
    const run = async () => {
      let docs;
      if (!Boolean(this.search)) {
        let aggregationPipelineWithPagination = await this.aggregationAddPagination(this.aggregationPipeline, this.pagination.after);
        docs = await this.Model.aggregate(aggregationPipelineWithPagination);
      } else {
        docs = await this.Model.aggregate(this.aggregationPipeline);
        docs = this.filterResults(docs, this.search, this.pagination);
      }
      return docs.map(doc => ({ node: doc, cursor: doc._id }));
    };
    if (!this.promises.edge) {
      this.promises.edge = run();
    }
    return this.promises.edge;
  }

  /**
   * Gets the end cursor value of the current limit and sort.
   * In this case, the cursor will be the document id, non-obfuscated.
   *
   * @return {Promise}
   */
  getEndCursor() {
    const run = async () => {
      const edges = await this.getEdges();
      if (!edges.length) return null;
      return edges[edges.length - 1].cursor;
    };
    if (!this.promises.cursor) {
      this.promises.cursor = run();
    }
    return this.promises.cursor;
  }

  /**
   * Determines if another page is available.
   *
   * @return {Promise}
   */
  async hasNextPage() {
    const run = async () => {
      let aggregationPipelineWithNextPage = await this.aggregationAddPagination(this.aggregationPipeline, (await this.getEndCursor())._id);
      const docs = await this.Model.aggregate(aggregationPipelineWithNextPage);
      return (docs.length > 0) ? true : false;
    };
    if (!this.promises.nextPage) {
      this.promises.nextPage = run();
    }
    return this.promises.nextPage;
  }
}

module.exports = Pagination;
