const path = require('node:path');
// The real path of the pearkit worktree (the file: dependency is a symlink; Tailwind must scan the sources).
const pearkitSrc = path.join(path.dirname(require.resolve('pearkit/package.json')), 'src');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}', `${pearkitSrc}/**/*.{ts,tsx}`],
  presets: [require('nativewind/preset'), require('pearkit/tailwind-preset')],
};
