// Chart.js for the Chart tab, in its own bundle: the collection tab loads it on first use.
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);
(window as unknown as { Chart: typeof Chart }).Chart = Chart;
