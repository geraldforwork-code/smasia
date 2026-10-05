import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Visual Studio keeps files in .vs locked; watching them makes the dev server log EBUSY errors.
  server: { watch: { ignored: ['**/.vs/**'] } },
});
