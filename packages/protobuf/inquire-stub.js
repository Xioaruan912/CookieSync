// Browser-safe stub replacing @protobufjs/inquire (which uses eval("quire".replace(/^/,"re")) for Node.js require).
// Eliminates eval() from MV3 extension bundles for Chrome Web Store CSP compliance.
export default function inquire() {
  return null;
}
