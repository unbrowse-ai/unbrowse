import { useMemo } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { clusterApiUrl } from '@solana/web3.js';

import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { Home } from './pages/Home';
import { SkillDetail } from './pages/SkillDetail';

// Import wallet adapter styles
import '@solana/wallet-adapter-react-ui/styles.css';

export function App() {
  // Solana network configuration
  const endpoint = useMemo(() => clusterApiUrl('mainnet-beta'), []);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BrowserRouter>
            <Header />
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/skill/:id" element={<SkillDetail />} />
            </Routes>
            <Footer />
          </BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default App;
