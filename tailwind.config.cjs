/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        shell: '#0d1524',
        panel: '#121d31',
        accent: '#5dd7ff',
        signal: '#74c69d',
        warn: '#f6bd60',
        danger: '#f28482',
      },
      boxShadow: {
        soft: '0 24px 80px rgba(0, 0, 0, 0.25)',
      },
      backgroundImage: {
        mesh:
          'radial-gradient(circle at top left, rgba(93, 215, 255, 0.14), transparent 28%), radial-gradient(circle at top right, rgba(116, 198, 157, 0.12), transparent 22%), linear-gradient(180deg, rgba(10, 17, 29, 0.98), rgba(10, 17, 29, 0.92))',
      },
    },
  },
  plugins: [],
};