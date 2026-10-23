# Architecture

`config.ts` validates local configuration. Sources default to disabled and account routing is supplied by the operator. `runtime.ts` enforces source selection before catalogue probes, searches or reads; CLI and MCP use that runtime. The MCP gateway loads configuration on each request, so disabling a source revokes future access without a transport restart. In-flight requests may finish with their original configuration.

Readers preserve original references, versions, source-specific errors, bounded text and pagination. Local paths are checked for containment and links. Provider tools receive argument arrays and fixed read commands, not interpolated shell commands. Calendar/Contacts never request permission from the retrieval interface.

Export rebuilds are explicit and include only enabled sources. Successful rebuilds replace disposable indexes atomically. Library maintenance is a separate entry point with an additional opt-in. Derived reads and discovery enforce the originating source's enablement; disabling `library` blocks derived discovery even if native readers remain enabled.

The native ZIP reader validates names, links, sizes and CRC. Document extraction is separate from retrieval and processes selected local files and eligible attachments. These parsers run with the operator's filesystem permissions; they are not a security sandbox.

Cache files are plaintext and require private storage. Previews are bounded and cleaned on subsequent preview access; an expiry label is not a timer. Explicit cache purging removes the default owned cache directory only after path checks. Custom paths require manual cleanup.

`loader.ts` bundles source changes and retains private temporary code bundles until process exit. This is convenient for local development but means the checkout itself must be trusted. There is no network listener, remote authorization layer, source writer or automatic installer.
