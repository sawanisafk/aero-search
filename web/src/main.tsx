/** Entry point — mounts the Aero desktop. */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/aero.css';

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('#root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
