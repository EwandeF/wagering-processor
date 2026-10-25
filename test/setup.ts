// Nos testes, o app sobe sem workers em segundo plano: cada teste liga o que precisa.
process.env.WORKERS_ENABLED = 'false';
