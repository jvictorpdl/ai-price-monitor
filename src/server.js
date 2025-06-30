require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const app = express();
const port = process.env.PORT || 3001;

// --- Configuração da API Gemini ---
const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
    console.error("Erro: A variável de ambiente GOOGLE_API_KEY não está definida.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- Configuração do Banco de Dados SQLite ---
const DB_PATH = path.join(__dirname, 'data', 'prices.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Erro ao abrir o banco de dados:', err.message);
    } else {
        console.log('Conectado ao banco de dados SQLite.');
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL UNIQUE,
            last_scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            features JSON
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            price_cash REAL NOT NULL,
            price_installment REAL,
            conditions JSON,
            scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        )`);
    }
});

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- Rota de Scraping e Análise de Preços ---
app.post('/api/scrape-product', async (req, res) => {
    const { productUrl } = req.body;

    if (!productUrl) {
        return res.status(400).json({ error: 'A URL do produto é obrigatória.' });
    }

    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 90000 });

        // --- Esperar pelos Seletores dos Preços ---
        try {
            await page.waitForSelector('#valVista', { timeout: 15000 });
            await page.waitForSelector('#valParc', { timeout: 15000 });
            console.log("Seletores de preço encontrados após espera.");
        } catch (error) {
            console.warn("Timeout ao esperar pelos seletores de preço. Tentando extrair mesmo assim.", error.message);
        }

        // --- Extração de Dados da TerabyteShop com Seletores Confirmados ---
        const productName = await page.$eval('h1.tit-prod', el => el.innerText.trim()).catch(() => null);
        const priceCashText = await page.$eval('#valVista', el => el.innerText.trim()).catch(() => null);
        console.log("Texto do preço à vista (#valVista):", priceCashText);

        const priceInstallmentText = await page.$eval('#valParc', el => el.innerText.trim()).catch(() => null);
        console.log("Texto do preço parcelado (#valParc):", priceInstallmentText);

        const technicalSpecsHtml = await page.$eval('.tecnicas', el => el.innerHTML).catch(() => null);
        const paymentConditionsText = await page.$eval('.box-pagamento-loja', el => el.innerText.trim()).catch(() => null);

        let priceCash = null;
        if (priceCashText) {
            priceCash = parseFloat(priceCashText.replace('R$', '').replace(/\./g, '').replace(',', '.').trim());
        }

        let priceInstallment = null;
        if (priceInstallmentText) {
            const match = priceInstallmentText.match(/R\$\s*([\d\.,]+)/);
            if (match && match[1]) {
                priceInstallment = parseFloat(match[1].replace(/\./g, '').replace(',', '.').trim());
            }
        }

        let normalizedConditions = null;
        if (paymentConditionsText) {
            const promptConditions = `
            Dado o seguinte texto de condições de pagamento e frete de um produto de e-commerce, extraia e normalize as informações relevantes.
            Concentre-se em termos como parcelamento (número de parcelas, juros), desconto à vista (percentual ou valor), e condições de frete (grátis, valor, regiões).
            Retorne em formato JSON. Se um campo não for encontrado ou não for aplicável, use null.

            Campos a extrair:
            - "tipo_pagamento_principal": Tipo principal de pagamento da oferta (ex: "boleto", "cartao_credito", "pix", "transferencia").
            - "desconto_a_vista_percentual": Percentual de desconto para pagamento à vista (número, ex: 10 para 10%).
            - "desconto_a_vista_valor": Valor do desconto fixo à vista (número).
            - "parcelas_sem_juros": Número máximo de parcelas sem juros (número inteiro).
            - "parcelas_com_juros": Número máximo de parcelas com juros (número inteiro).
            - "texto_frete_gratis": Se há menção explícita de frete grátis (booleano).
            - "condicao_frete_gratis": Condição para frete grátis (ex: "acima de R$X", "para região Y", "null").
            - "texto_original_condicoes": O texto completo das condições de pagamento/frete fornecido.

            Exemplos (baseados em padrões comuns de e-commerce, refine com exemplos da Terabyte se necessário):
            1. Texto: "R$ 1.500,00 no PIX (10% de desconto) ou em até 12x de R$ 150,00 sem juros"
               JSON: {"tipo_pagamento_principal": "pix", "desconto_a_vista_percentual": 10, "desconto_a_vista_valor": 150.00, "parcelas_sem_juros": 12, "parcelas_com_juros": null, "texto_frete_gratis": false, "condicao_frete_gratis": null, "texto_original_condicoes": "R$ 1.500,00 no PIX (10% de desconto) ou em até 12x de R$ 150,00 sem juros"}
            2. Texto: "Frete Grátis para Sul e Sudeste nas compras acima de R$500"
               JSON: {"tipo_pagamento_principal": null, "desconto_a_vista_percentual": null, "desconto_a_vista_valor": null, "parcelas_sem_juros": null, "parcelas_com_juros": null, "texto_frete_gratis": true, "condicao_frete_gratis": "acima de R$500 para Sul e Sudeste", "texto_original_condicoes": "Frete Grátis para Sul e Sudeste nas compras acima de R$500"}
            3. Texto: "Em até 10x sem juros no cartão ou 5% de desconto no boleto"
               JSON: {"tipo_pagamento_principal": "cartao_credito", "desconto_a_vista_percentual": 5, "desconto_a_vista_valor": null, "parcelas_sem_juros": 10, "parcelas_com_juros": null, "texto_frete_gratis": false, "condicao_frete_gratis": null, "texto_original_condicoes": "Em até 10x sem juros no cartão ou 5% de desconto no boleto"}

            Texto das Condições:
            ${paymentConditionsText}
            `;

            try {
                const result = await model.generateContent(promptConditions);
                const responseText = result.response.text();
                let jsonString = responseText.replace(/```json\n?|\n?```/g, '').trim();
                normalizedConditions = JSON.parse(jsonString);
            } catch (geminiError) {
                console.error('Erro na análise de condições com Gemini:', geminiError);
                normalizedConditions = { error: 'Falha na análise Gemini de condições.' };
            }
        }

        let extractedFeatures = null;
        if (technicalSpecsHtml) {
            const promptFeatures = `
            O texto a seguir contém especificações técnicas de um componente de hardware no formato HTML, com pares de "chave: valor".
            Extraia todas as características e seus respectivos valores, normalizando os nomes das chaves para snake_case e convertendo valores numéricos quando apropriado.
            Retorne em formato JSON. Se um campo não for encontrado ou não for aplicável, use null.
            Desconsidere formatação HTML como <p>, <strong>, <br>.

            Exemplo de input:
            <p><strong>Marca:</strong><br>XFX</p><p><strong>Modelo:</strong><br>RX-76PQICKBY</p><p><strong>Bus Type:</strong><br>PCI-E 4.0</p>
            <p><strong>Base clock Up to:</strong><br>1875 MHz</p><p><strong>Memory Size:</strong><br>8 GB</p><p><strong>DisplayPort 2.1:</strong><br>3x</p>

            Exemplo de Output JSON:
            {
              "marca": "XFX",
              "modelo": "RX-76PQICKBY",
              "bus_type": "PCI-E 4.0",
              "base_clock_up_to_mhz": 1875,
              "memory_size_gb": 8,
              "display_port_2_1_quantity": 3
            }

            Especificações Técnicas (HTML):
            ${technicalSpecsHtml}
            `;

            try {
                const result = await model.generateContent(promptFeatures);
                const responseText = result.response.text();
                let jsonString = responseText.replace(/```json\n?|\n?```/g, '').trim();
                extractedFeatures = JSON.parse(jsonString);
            } catch (geminiError) {
                console.error('Erro na análise de características com Gemini:', geminiError);
                extractedFeatures = { error: 'Falha na análise Gemini de características.' };
            }
        }

        // --- Salvar no Banco de Dados ---
        try {
            // 1. Inserir ou atualizar o Produto e obter seu ID
            const productId = await new Promise((resolve, reject) => {
                const stmtProduct = db.prepare(`
                    INSERT INTO products (name, url, features) VALUES (?, ?, ?)
                    ON CONFLICT(url) DO UPDATE SET name=excluded.name, features=excluded.features, last_scraped_at=CURRENT_TIMESTAMP
                `);
                stmtProduct.run(productName, productUrl, JSON.stringify(extractedFeatures), function(err) {
                    if (err) {
                        console.error('Erro ao inserir/atualizar produto:', err.message);
                        stmtProduct.finalize();
                        return reject(new Error('Erro ao salvar produto no DB.'));
                    }

                    if (this.lastID) {
                        stmtProduct.finalize();
                        return resolve(this.lastID);
                    } else {
                        // Se foi um UPDATE (ON CONFLICT), precisamos buscar o ID da linha existente
                        db.get("SELECT id FROM products WHERE url = ?", [productUrl], (err, row) => {
                            stmtProduct.finalize();
                            if (err || !row) {
                                console.error('Erro ao buscar ID do produto após ON CONFLICT:', err ? err.message : 'Produto não encontrado no DB após update.');
                                return reject(new Error('Erro ao obter ID do produto para salvar preço.'));
                            }
                            resolve(row.id);
                        });
                    }
                });
            });

            // 2. Inserir o novo registro de Preço usando o productId obtido
            const stmtPrice = db.prepare(`INSERT INTO prices (product_id, price_cash, price_installment, conditions, scraped_at) VALUES (?, ?, ?, ?, ?)`);
            await new Promise((resolve, reject) => {
                stmtPrice.run(
                    productId,
                    priceCash,
                    priceInstallment,
                    JSON.stringify(normalizedConditions),
                    new Date().toISOString(),
                    function(err) {
                        if (err) {
                            console.error('Erro ao inserir preço:', err.message);
                            return reject(new Error('Erro ao salvar preço no DB.'));
                        }
                        resolve();
                    }
                );
            });
            stmtPrice.finalize();

            res.json({
                message: 'Dados raspados e salvos com sucesso!',
                product: { name: productName, url: productUrl },
                priceCash: priceCash, 
                priceInstallment: priceInstallment, 
                normalizedConditions: normalizedConditions,
                extractedFeatures: extractedFeatures
            });

        } catch (dbError) {
            console.error('Erro no fluxo de salvamento do DB:', dbError);
            res.status(500).json({ error: dbError.message || 'Erro interno do servidor ao salvar dados.' });
        }

    } catch (error) {
        console.error('Erro no scraping ou processamento:', error);
        res.status(500).json({ error: error.message || 'Ocorreu um erro no servidor durante o scraping.' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// --- Rotas para o Frontend (Servir o React App em Produção) ---
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'client/build')));
    app.get('*', function (req, res) {
        res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
    });
}

// --- Inicia o Servidor ---
app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    console.log(`API Key carregada: ${API_KEY ? 'Sim' : 'Não'}`);
});

// Garante que o banco de dados seja fechado ao encerrar o processo
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Conexão com o banco de dados SQLite fechada.');
        process.exit(0);
    });
});