/* global __dirname */
const path = require('node:path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.resolve(__dirname, 'app/**/*.{ts,tsx}'),
    path.resolve(__dirname, 'components/**/*.{ts,tsx}'),
  ],
  theme: { extend: {} },
  plugins: [],
};
