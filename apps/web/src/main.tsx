import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing — index.html was not served correctly');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
