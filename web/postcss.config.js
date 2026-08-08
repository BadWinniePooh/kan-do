// Tailwind v4 ships its PostCSS integration as a separate package, and handles
// vendor prefixing itself — autoprefixer is no longer part of the chain.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
