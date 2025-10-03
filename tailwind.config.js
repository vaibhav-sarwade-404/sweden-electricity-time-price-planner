/** @type {import('tailwindcss').Config} */
module.exports = {
  // CRITICAL: This 'content' array tells Tailwind where to look for class names.
  content: [
    "./**/*.html", // Scan all HTML files in the root directory
    "./src/**/*.js", // Scan all JavaScript files in the src directory
    // If you had a dedicated HTML file, you'd list it here:
    // './electricity-planner.html',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
