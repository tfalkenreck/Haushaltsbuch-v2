import { AccountsPage } from './pages/AccountsPage';
import { ImportPage } from './pages/ImportPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { hrefFor, useRoute, type Page } from './lib/route';

const NAV: { page: Page; label: string }[] = [
  { page: 'konten', label: 'Konten' },
  { page: 'import', label: 'Import' },
  { page: 'buchungen', label: 'Buchungen' },
];

export function App() {
  const route = useRoute();

  return (
    <main>
      <header className="app-header">
        <h1>Haushaltsbuch</h1>
        <nav>
          {NAV.map((item) => (
            <a key={item.page} href={hrefFor(item.page)} className={route.page === item.page ? 'active' : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      {route.page === 'konten' && <AccountsPage />}
      {route.page === 'import' && <ImportPage params={route.params} />}
      {route.page === 'buchungen' && <TransactionsPage params={route.params} />}
    </main>
  );
}
