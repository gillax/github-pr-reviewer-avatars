/**
 * fake-row.js — a tiny, dependency-free stand-in for a GitHub PR list row
 * Element, exposing only the surface that parse.extractPrNumberFromRow touches:
 *   - getAttribute('id')
 *   - querySelectorAll('a[href]')  (returns objects with getAttribute('href'))
 *
 * This lets us exercise the row-markup extraction path under Node without jsdom
 * or any other external dependency (the spec mandates no npm install).
 */

'use strict';

/**
 * @param {{ id?: string|null, hrefs?: string[] }} opts
 * @returns {object} an object shaped like the subset of Element we use.
 */
function makeRow(opts = {}) {
  const { id = null, hrefs = [] } = opts;
  const anchors = hrefs.map((href) => ({
    getAttribute(name) {
      return name === 'href' ? href : null;
    },
  }));
  return {
    getAttribute(name) {
      if (name === 'id') {
        return id;
      }
      return null;
    },
    querySelectorAll(selector) {
      // We only ever ask for 'a[href]'.
      if (selector === 'a[href]') {
        return anchors;
      }
      return [];
    },
  };
}

module.exports = { makeRow };
