import { createRoot } from 'react-dom/client';
import App from './App';
import { SitesProvider } from './sites';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在');
createRoot(root).render(
  <SitesProvider>
    <App />
  </SitesProvider>,
);
