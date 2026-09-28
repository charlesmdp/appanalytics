import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled rather than fetched: a self-hosted dashboard should not have its
// typography depend on reaching a font CDN.
import '@fontsource-variable/inter';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
