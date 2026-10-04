# Contributing

Thanks for taking the time.

- **Zero dependencies.** Node examples use only `node:*` modules; Python examples use only the standard library. A pull request that adds a dependency will be asked to remove it.
- **Tests with every change.** `cd node && npm test` and `cd python && python -m unittest discover -s tests -v` must pass.
- **One pattern per file.** Keep each example readable on its own, with a short comment block explaining the why, not only the how.
- **No secrets, ever.** Not even "test" tokens that look real. The test suites use the literal string `test-secret-not-a-real-credential`.
- English or French are both fine in issues and pull requests.
