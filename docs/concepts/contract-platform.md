# The contract platform

Every Unbrowse operation has a typed input, a declared capability, a result, and
a next step. The same shape appears in the CLI, SDK, Agent Skill, and MCP.

The contract boundary carries intent, optional URL and parameters, approval for
mutating actions, and pointers to local capabilities. It does not carry site
secrets. The local runtime resolves those pointers only when executing on the
matching machine.

This makes failures actionable: a missing route asks for capture, expired auth
asks for login, and insufficient credits asks for account credit. No layer may
turn an unmet precondition into a successful result.
