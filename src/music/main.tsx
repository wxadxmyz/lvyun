import React from 'react';
import ReactDOM from 'react-dom/client';
import MusicApp from './MusicApp';
import { ThemeProvider } from '../lib/theme';
import { ToastProvider } from '../lib/toast';
import '../styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <MusicApp />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
);
