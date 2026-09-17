// query-string 7 requires a callable CommonJS decoder; the security-fixed
// decode-uri-component 0.5 exports a default ESM function. Keep both shapes
// compatible until React Navigation upgrades its query-string dependency.
const fs = require('node:fs');
const file = require.resolve('query-string');
const original = "const decodeComponent = require('decode-uri-component');";
const replacement =
  "const decodeModule = require('decode-uri-component');\nconst decodeComponent = decodeModule.default || decodeModule;";
const source = fs.readFileSync(file, 'utf8');
if (source.includes(original)) fs.writeFileSync(file, source.replace(original, replacement));
else if (!source.includes(replacement))
  throw new Error('query-string changed; review the decoder interop patch before building.');
