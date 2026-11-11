/*!
 * Siberi AI SDK v1.0
 * Connect your project to Siberi AI in one line.
 * Works in browser (<script> tag) and Node.js (require/import).
 *
 * Usage:
 *   const api = SiberiAI({ apiKey: 'YOUR_API_KEY' });
 *   const rows = await api.records.list('products');
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();           // Node.js / CommonJS
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);                  // AMD (RequireJS)
  } else {
    root.SiberiAI = factory();            // Browser global
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_BASE = 'https://siberi.online/api/v1';

  function SiberiAI(options) {
    if (!options || !options.apiKey) {
      throw new Error('[SiberiAI] apiKey is required: SiberiAI({ apiKey: "..." })');
    }

    var base = (options.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
    var apiKey = options.apiKey;

    // ── Core request ──────────────────────────────────────────
    function req(method, path, body) {
      var url = base + path;
      var opts = {
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
      };
      if (body !== undefined) opts.body = JSON.stringify(body);

      return fetch(url, opts).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Siberi AI API error ' + res.status);
          return data;
        });
      });
    }

    // ── Polling helper ─────────────────────────────────────────
    function poll(taskId, interval) {
      interval = interval || 1500;
      return new Promise(function (resolve, reject) {
        function check() {
          req('GET', '/result/' + taskId).then(function (data) {
            if (data.status === 'completed') return resolve(data.result);
            if (data.status === 'error')     return reject(new Error(data.error));
            setTimeout(check, interval);
          }).catch(function (err) {
            setTimeout(check, interval * 2);
          });
        }
        check();
      });
    }

    // ── Records API ────────────────────────────────────────────
    var records = {
      /**
       * Get all records for a schema.
       * @param {string} schema  - Schema name (e.g. 'products')
       * @param {object} options - { page, limit, search, sortBy, sortOrder }
       */
      list: function (schema, options) {
        var params = new URLSearchParams();
        options = options || {};
        if (options.page)      params.set('page',      options.page);
        if (options.limit)     params.set('limit',     options.limit);
        if (options.search)    params.set('search',    options.search);
        if (options.sortBy)    params.set('sortBy',    options.sortBy);
        if (options.sortOrder) params.set('sortOrder', options.sortOrder);
        var qs = params.toString();
        return req('GET', '/data/records/' + schema + (qs ? '?' + qs : ''));
      },

      /**
       * Create a new record.
       * @param {string} schema - Schema name
       * @param {object} data   - Record data fields
       */
      create: function (schema, data) {
        return req('POST', '/data/records/' + schema, { data: data });
      },

      /**
       * Update an existing record.
       * @param {string} schema - Schema name
       * @param {string} id     - Record _id
       * @param {object} data   - Updated fields
       */
      update: function (schema, id, data) {
        return req('PUT', '/data/records/' + schema + '/' + id, { data: data });
      },

      /**
       * Delete a record.
       * @param {string} schema - Schema name
       * @param {string} id     - Record _id
       */
      delete: function (schema, id) {
        return req('DELETE', '/data/records/' + schema + '/' + id);
      },
    };

    // ── Schemas API ────────────────────────────────────────────
    var schemas = {
      /** Get all schemas for this account. */
      list: function () {
        return req('GET', '/data/schemas');
      },
    };

    // ── AI Chat API ────────────────────────────────────────────
    var chat = {
      /**
       * Send a prompt to the AI and wait for the response.
       * Handles async polling automatically.
       * @param {string} prompt  - User prompt
       * @param {object} options - { context: { platform, platformUserId } }
       * @returns {Promise<string>} - AI response text
       */
      send: function (prompt, options) {
        var body = Object.assign({ prompt: prompt }, options || {});
        return req('POST', '/analyze', body).then(function (data) {
          return poll(data.taskId);
        });
      },
    };

    return {
      records: records,
      schemas: schemas,
      chat: chat,
      /** Low-level request — use if you need a custom endpoint. */
      _request: req,
    };
  }

  return SiberiAI;
}));
