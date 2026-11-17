// footer-empty fails a commit whose body has a line commitlint parses as a footer token, such as a wrapped line that
// starts with `word:`; a breaking change uses `!` in the subject.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: { "footer-empty": [2, "always"] },
};
