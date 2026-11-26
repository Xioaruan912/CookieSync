import Options from '@src/Options';
import '@src/index.css';
import '@src/overview.css';
import '@src/automation.css';
import '@src/connection.css';
import '@src/adaptations.css';
import '@src/sites.css';
import '@src/about.css';
import { ThemeProvider } from '@sync-your-cookie/shared';
import '@sync-your-cookie/ui/css';
import { createRoot } from 'react-dom/client';

function init() {
  const appContainer = document.querySelector('#app-container');
  if (!appContainer) {
    throw new Error('Can not find #app-container');
  }
  const root = createRoot(appContainer);
  root.render(
    <ThemeProvider>
      <Options />
    </ThemeProvider>,
  );
}

init();
