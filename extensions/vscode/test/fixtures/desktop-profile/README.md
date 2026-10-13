Synthetic desktop profile for the «Importar de Vortaq» tests: a `connections.json` written to the
layout of the desktop app's profile (`ConnectionsRepo`, `{ items: [...] }`). Hosts use the reserved
`.test` domain; no real hosts, users or data. The tests add a `credentials.json` next to it at run
time and check that the importer never opens it.
