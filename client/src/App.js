// gemini-invoice-extractor/client/src/App.js
import React, { useState } from 'react';
import './App.css';

function App() {
  const [productUrl, setProductUrl] = useState(''); // Estado para a URL do produto
  const [scrapedData, setScrapedData] = useState(null); // Estado para os dados raspados
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleUrlChange = (event) => {
    setProductUrl(event.target.value);
    setScrapedData(null);
    setError(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!productUrl) {
      setError('Por favor, insira a URL do produto.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/scrape-product', { // Nova rota
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', // Agora enviamos JSON, não FormData
        },
        body: JSON.stringify({ productUrl }), // Enviamos a URL no corpo
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erro desconhecido ao raspar o produto.');
      }

      const data = await response.json();
      setScrapedData(data);
    } catch (err) {
      console.error('Erro ao enviar a URL:', err);
      setError(err.message || 'Ocorreu um erro inesperado.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <h1 className="app-title">
          <span className="gradient-text">Gemini</span> Monitor de Preços
        </h1>
        <p className="app-subtitle">
          Analise preços e ofertas de e-commerces com IA.
        </p>
      </header>

      <main className="main-content">
        <section className="scrape-section">
          <form onSubmit={handleSubmit} className="scrape-form">
            <input
              type="url" // Tipo url para validação básica do navegador
              placeholder="Cole a URL do produto aqui (ex: https://loja.com/produto)"
              value={productUrl}
              onChange={handleUrlChange}
              className="url-input"
              required
            />
            <button
              type="submit"
              className="submit-button"
              disabled={loading || !productUrl}
            >
              {loading ? (
                <>
                  <span className="spinner"></span> Raspando...
                </>
              ) : (
                'Analisar Produto'
              )}
            </button>
          </form>

          {error && <p className="message error-message" role="alert">Erro: {error}</p>}
          {loading && !error && <p className="message loading-message">Buscando e analisando dados do produto...</p>}
        </section>


            {scrapedData && (
              <section className="results-section">
                <h2 className="results-title">Dados do Produto Raspados:</h2>
                <div className="extracted-data-card">
                  <div className="data-row">
                    <span className="data-label">Nome:</span>
                    <span className="data-value">{scrapedData.product?.name || 'N/A'}</span>
                  </div>
                  <div className="data-row">
                    <span className="data-label">URL:</span>
                    <span className="data-value"><a href={scrapedData.product?.url} target="_blank" rel="noopener noreferrer">{scrapedData.product?.url || 'N/A'}</a></span>
                  </div>
                  <div className="data-row">
                    <span className="data-label">Preço à Vista:</span> {/* Texto ajustado */}
                    <span className="data-value">R$ {scrapedData.priceCash?.toFixed(2) || 'N/A'}</span> {/* Usar priceCash */}
                  </div>
                  <div className="data-row">
                    <span className="data-label">Preço Parcelado:</span> {/* Novo campo */}
                    <span className="data-value">R$ {scrapedData.priceInstallment?.toFixed(2) || 'N/A'}</span> {/* Usar priceInstallment */}
                  </div>
                  {scrapedData.normalizedConditions && (
                    <>
                      <h3 className="items-title">Condições da Oferta (Gemini):</h3>
                      <pre className="raw-json-code">
                        {JSON.stringify(scrapedData.normalizedConditions, null, 2)}
                      </pre>
                    </>
                  )}
                   {scrapedData.extractedFeatures && (
                    <>
                      <h3 className="items-title">Características Extraídas (Gemini):</h3>
                      <pre className="raw-json-code">
                        {JSON.stringify(scrapedData.extractedFeatures, null, 2)}
                      </pre>
                    </>
                  )}

                </div>
              </section>
        )}
      </main>
      <footer className="app-footer">
        <p>&copy; 2025 Gemini AI - Monitor de Preços</p>
      </footer>
    </div>
  );
}

export default App;