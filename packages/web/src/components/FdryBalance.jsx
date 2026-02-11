import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiUrl } from '../lib/api-base';

export default function FdryBalance({ wallet }) {
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!wallet) return;

    const fetchBalance = async () => {
      try {
        const res = await fetch(apiUrl(`/fdry/balance/${wallet}`));
        if (res.ok) {
          const data = await res.json();
          setBalance(data.balance ?? data.credits ?? 0);
        }
      } catch (err) {
        console.error('Failed to fetch FDRY balance:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchBalance();
    const interval = setInterval(fetchBalance, 60000);
    return () => clearInterval(interval);
  }, [wallet]);

  if (!wallet) return null;

  const formatBalance = (val) => {
    if (val == null) return '--';
    if (val >= 1000) return (val / 1000).toFixed(1) + 'K';
    return Math.floor(val).toLocaleString();
  };

  return (
    <Link to="/earnings" className="fdry-badge" title="FDRY Credits">
      <span className="fdry-icon">F</span>
      <span className="fdry-amount">
        {loading ? '--' : formatBalance(balance)}
      </span>
      <span className="fdry-label">FDRY</span>
    </Link>
  );
}
