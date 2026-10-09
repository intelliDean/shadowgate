/**
 * Pinned reference application from x402-foundation/x402
 * Repository: https://github.com/x402-foundation/x402
 * Pinned Commit: 7f2b2f1f77fa5317615735e3378a6fad41cccb4e
 * Path: examples/typescript/servers/express/index.ts
 */

import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';

export function createWeatherApp(options: {
  svmAddress: string;
  assetMint: string;
  priceAmount: string;
  facilitatorUrl: string;
  rpcUrl?: string;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  const facilitatorClient = new HTTPFacilitatorClient({ url: options.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    SOLANA_DEVNET_CAIP2,
    new ExactSvmScheme({ rpcUrl: options.rpcUrl })
  );

  app.use(
    paymentMiddleware(
      {
        'GET /weather': {
          accepts: [
            {
              scheme: 'exact',
              price: { asset: options.assetMint, amount: options.priceAmount },
              network: SOLANA_DEVNET_CAIP2,
              payTo: options.svmAddress,
            },
          ],
          description: 'Weather data from x402-foundation example',
          mimeType: 'application/json',
        },
      },
      resourceServer
    )
  );

  app.get('/weather', (_req, res) => {
    res.json({
      report: {
        weather: 'sunny',
        temperature: 70,
      },
    });
  });

  return app;
}
