import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';

@Injectable()
export class PublicAuthMiddleware implements NestMiddleware {
  constructor(
    private _organizationService: OrganizationService,
    private _oauthService: OAuthService
  ) {}
  async use(req: Request, res: Response, next: NextFunction) {
    const rawAuth = (req.headers.authorization ||
      req.headers.Authorization) as string;
    if (!rawAuth) {
      res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'No API Key found' });
      return;
    }

    // The MCP endpoint expects `Authorization: Bearer <key>` while this one
    // historically wanted the bare key, which is a pointless trap when both are
    // driven by the same credential. Accept either form here.
    const auth = rawAuth.replace(/^Bearer\s+/i, '').trim();

    try {
      if (auth.startsWith('pos_')) {
        const authorization = await this._oauthService.getOrgByOAuthToken(auth);
        if (!authorization) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'Invalid OAuth token' });
          return;
        }

        const org = authorization.organization;
        if (!!process.env.STRIPE_SECRET_KEY && !org.subscription) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'No subscription found' });
          return;
        }

        // @ts-ignore
        req.org = { ...org, users: [{ users: { role: 'SUPERADMIN' } }] };
      } else {
        const org = await this._organizationService.getOrgByApiKey(auth);
        if (!org) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'Invalid API key' });
          return;
        }

        if (!!process.env.STRIPE_SECRET_KEY && !org.subscription) {
          res
            .status(HttpStatus.UNAUTHORIZED)
            .json({ msg: 'No subscription found' });
          return;
        }

        // @ts-ignore
        req.org = { ...org, users: [{ users: { role: 'SUPERADMIN' } }] };
      }
    } catch (err) {
      throw new HttpForbiddenException();
    }
    next();
  }
}
