import { Elysia } from 'elysia'
import { openapi } from '@elysiajs/openapi'
import { instruments } from './modules/instruments'
import { expiredInstruments } from './modules/expired-instruments'
import { historicalData } from './modules/historical-data'
import { marketQuote } from './modules/market-quote'
import { optionChain } from './modules/option-chain'
import { marketInfo } from './modules/market-info'
import { fundamentals } from './modules/fundamentals'
import { news } from './modules/news'
import { stream } from './modules/stream'
import { backtestData } from './modules/backtest-data'

const app = new Elysia()
  .use(
    openapi({
      path: '/swagger',
      documentation: {
        info: { title: 'Harnesh Trading API', version: '1.0.0' },
      },
      // SSE + WS are streaming endpoints — can't be executed via Swagger "Try it out".
      // SSE route hides itself via detail.hide; WS route needs plugin-level exclude (.ws() ignores detail.hide).
      exclude: { paths: ['/stream/market-data'] },
    }),
  )
  .use(instruments)
  .use(expiredInstruments)
  .use(historicalData)
  .use(marketQuote)
  .use(optionChain)
  .use(marketInfo)
  .use(fundamentals)
  .use(news)
  .use(stream)
  .use(backtestData)
  .get('/', () => 'Hello from Harnesh Trading API')
  .listen(3000)

console.log(`API running at http://localhost:3000`)
console.log(`Swagger UI at http://localhost:3000/swagger`)