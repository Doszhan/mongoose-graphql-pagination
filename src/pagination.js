const deepMerge = require('deepmerge');
const ObjectId = require("mongoose").Types.ObjectId;
const { getNestedValue } = require("./utils");

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
    this.aggregationPipeline = baseAggregationPipeline;

    // Search programmatically later (Azure Cosmos DB compatibility).
    this.search = search;

    this.pagination = pagination;

    for (let filter of filters) {
      this.aggregationPipeline.push(
        {
          $match: {
            [ filter.field ]: filter.value
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
   * @param results Mongoose results.
   * @param search  string to find (supports regex)
   *
   * @return Mongoose results
   */
  filterResults(results, search) {
    let regex = new RegExp(search);

    results = results.filter(function(result) {
      for (let value of Object.values(result)) {
        if (regex.exec(value)) {
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
      aggregationPipelineFindOne.push({
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

  async aggregationAddPagination(aggregationPipeline, pagination) {
    let aggregationPipelineWithPagination = aggregationPipeline.slice();

    // Set after cursor.
    if (Boolean(this.pagination.after)) {
      const cursorModel = await this.findCursorModel(this.pagination.after);
      const orderDirection = this.sort.order == 1 ? '$gt' : '$lt';

      let ors = [];
      if (Boolean(this.sort.field) && Boolean(this.sort.order)) {
        ors.push({
          [ this.sort.field ]: { [ orderDirection ]: cursorModel[this.sort.field] }
        });
      }
      ors.push({
        _id: { $gt: ObjectId(this.pagination.after) }
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
      let aggregationPipelineWithPagination = await this.aggregationAddPagination(this.aggregationPipeline, this.pagination);

      let docs = await this.Model.aggregate(aggregationPipelineWithPagination);
      if (Boolean(this.search)) {
        docs = this.find(docs, this.search);
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
      let aggregationPipelineNoPerPage = this.aggregationPipeline.slice();
      aggregationPipelineNoPerPage.push({
        $count: "count"
      });
      const countResults = await this.Model.aggregate(aggregationPipelineNoPerPage);
      const count = (countResults.length > 0) ? countResults[0]["count"] : 0;
      return count > this.perPage;
    };
    if (!this.promises.nextPage) {
      this.promises.nextPage = run();
    }
    return this.promises.nextPage;
  }
}

module.exports = Pagination;
