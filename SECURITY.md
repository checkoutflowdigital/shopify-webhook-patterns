# Security

This repository contains reference code only. It holds no credentials, no customer data and no production configuration.

If you believe one of the examples has a security flaw (for example a verification bypass or a timing issue), please open a GitHub issue describing the problem and, if possible, a failing test. Reports are read and fixed; there is no bug bounty.

When adapting the examples:

- keep secrets in the environment or a secret manager, never in source, themes or front-end code;
- verify signatures before parsing request bodies;
- share the idempotency ledger between all worker processes;
- request only the API scopes the job needs.
