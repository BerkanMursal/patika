const path = require('node:path');
const sharp = require(path.resolve(__dirname, '../../node_modules/sharp'));
const root = path.resolve(__dirname, '../assets');
Promise.all(
  [
    ['icon.png', 1024],
    ['adaptive-icon.png', 1024],
    ['favicon.png', 64],
  ].map(([file, size]) =>
    sharp(path.join(root, 'brand.svg')).resize(size, size).png().toFile(path.join(root, file)),
  ),
).catch((e) => {
  console.error(e);
  process.exit(1);
});
