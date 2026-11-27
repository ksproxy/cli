export const REVIEWED = '- A command that is not on this list is reviewed before it runs and may be refused.';

// Each value as JSON writes it inside a string (a quote, a backslash and the control characters escaped, as
// JSON.stringify does), where that is not one of the values as it is: a reply in JSON shows a secret in that form, and
// the core hides it with the values.
export function jsonForms(values) {
  return values.map((value) => JSON.stringify(value).slice(1, -1)).filter((form) => !values.includes(form));
}

// jsonForms for the body of a service whose JSON writer is not known, each form once: as JSON.stringify writes it; that
// with a slash written as a backslash and a slash (PHP); and that with the less-than, greater-than and ampersand signs
// written as \u003c, \u003e and \u0026 (Go, Rails). Other ways of writing JSON are not known here.
const HTML_SAFE = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' };
export function jsonBodyForms(values) {
  const forms = values.flatMap((value) => {
    const plain = JSON.stringify(value).slice(1, -1);
    return [plain, plain.replaceAll('/', '\\/'), plain.replace(/[<>&]/g, (sign) => HTML_SAFE[sign])];
  });
  return [...new Set(forms)].filter((form) => !values.includes(form));
}
