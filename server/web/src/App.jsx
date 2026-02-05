import { Routes, Route } from 'react-router-dom';
import Skills from './pages/Skills';
import SkillDetail from './pages/SkillDetail';
import Search from './pages/Search';
import Docs from './pages/Docs';
import Analytics from './pages/Analytics';
import Layout from './components/Layout';

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Skills />} />
        <Route path="/search" element={<Search />} />
        <Route path="/skill/:id" element={<SkillDetail />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/analytics" element={<Analytics />} />
      </Route>
    </Routes>
  );
}

export default App;
