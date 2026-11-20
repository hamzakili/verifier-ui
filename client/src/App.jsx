import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider } from './context/ToastContext';
import { AppProvider } from './context/AppContext';
import { BulkProvider } from './context/BulkContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SingleVerifier from './pages/SingleVerifier';
import BulkVerifier from './pages/BulkVerifier';
import BulkJobs from './pages/BulkJobs';
import NewBulkJob from './pages/NewBulkJob';
import BulkJobDetail from './pages/BulkJobDetail';
import Files from './pages/Files';
import History from './pages/History';
import Registry from './pages/Registry';

export default function App() {
  return (
    <ToastProvider>
      <AppProvider>
        <BulkProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Dashboard />} />
                <Route path="single" element={<SingleVerifier />} />
                <Route path="bulk" element={<BulkVerifier />} />
                <Route path="bulk-jobs" element={<BulkJobs />} />
                <Route path="bulk-jobs/new" element={<NewBulkJob />} />
                <Route path="bulk-jobs/:jobId" element={<BulkJobDetail />} />
                <Route path="history" element={<History />} />
                <Route path="files" element={<Files />} />
                <Route path="files/:folderId" element={<Files />} />
                <Route path="registry" element={<Registry />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </BulkProvider>
      </AppProvider>
    </ToastProvider>
  );
}
