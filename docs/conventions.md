# Conventions

Keep the client thin. Server handles site discovery, sessions and execution. Preserve structured error codes and run states. JSON output belongs on stdout; guidance belongs on stderr. Never print credentials. Add behavioral tests for wire changes and document supported operations, not speculative ones.
