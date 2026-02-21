import { Navigate, Route, Routes } from "react-router-dom";
import HomePage from "./pages/HomePage";
import EditorPage from "./pages/EditorPage";
import SharePage from "./pages/SharePage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/edit/:dashboardId" element={<EditorPage />} />
      <Route path="/d/:dashboardId" element={<SharePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
