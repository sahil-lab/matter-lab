import '../../../styles/app.css';
import { mountHarness } from './app';

const root = document.getElementById('root');
if (!root) throw new Error('Harness root element (#root) is missing from lab-experiments-harness.html.');
mountHarness(root);
