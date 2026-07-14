import { createRoot } from 'react-dom/client';
import { GatewayRoot } from './app/router.js';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('gateway_root_missing');

createRoot(root).render(<GatewayRoot />);
