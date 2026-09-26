// Removes null/undefined-valued keys from a flat object, so API responses
// only show fields that actually have a value instead of cluttering the
// payload with nulls for data a given platform/format didn't provide.
function stripNullish(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

module.exports = { stripNullish };
