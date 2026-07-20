import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startExtensionImportHandler } from './ui/sync/extensionImport';
import { AppErrorBoundary } from './ui/shell/AppErrorBoundary';
import './ui/tokens.css';

// Register the extension-bridge import listener before first paint so the
// main process can forward /v1/import payloads as soon as the page loads.
startExtensionImportHandler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
