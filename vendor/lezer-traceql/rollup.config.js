export default {
  input: "./src/index.js",
  external: ["@lezer/lr"],
  output: [{
    format: "cjs",
    file: "./index.cjs"
  }, {
    format: "es",
    file: "./index.es.js"
  }],
}
