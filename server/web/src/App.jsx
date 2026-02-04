import { Routes, Route } from 'react-router-dom';
import Skills from './pages/Skills';
import SkillDetail from './pages/SkillDetail';
import Docs from './pages/Docs';
import Layout from './components/Layout';

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Skills />} />
        <Route path="/skill/:id" element={<SkillDetail />} />
        <Route path="/docs" element={<Docs />} />
      </Route>
    </Routes>
  );
}

export default App;
