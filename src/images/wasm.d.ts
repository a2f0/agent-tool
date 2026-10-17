// Bun embeds the file in compiled executables and resolves it from node_modules otherwise.
declare module "@resvg/resvg-wasm/index_bg.wasm" {
  const path: string;
  export default path;
}
