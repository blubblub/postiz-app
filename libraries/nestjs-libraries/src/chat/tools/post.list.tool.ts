import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { organizationFromContext } from '@gitroom/nestjs-libraries/chat/tools/comment.context';

@Injectable()
export class PostListTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'postList';

  run() {
    return createTool({
      id: 'postList',
      description: `List scheduled and published posts in a date range. Returns post ids usable with postDelete and postAnalytics. Dates are ISO strings.`,
      inputSchema: z.object({
        startDate: z
          .string()
          .describe('ISO date to list from, e.g. 2026-08-01T00:00:00.000Z'),
        endDate: z
          .string()
          .describe('ISO date to list until, e.g. 2026-08-31T23:59:59.000Z'),
        customer: z
          .string()
          .optional()
          .describe('Optional customer/group id to filter by'),
      }),
      mcp: {
        annotations: {
          title: 'List Posts',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      outputSchema: z.object({
        posts: z.array(
          z.object({
            id: z.string(),
            content: z.string().optional(),
            publishDate: z.string().optional(),
            state: z.string().optional(),
            group: z.string().optional(),
            integrationId: z.string().optional(),
          })
        ),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = organizationFromContext(context);

        const posts = await this._postsService.getPosts(organizationId, {
          startDate: inputData.startDate,
          endDate: inputData.endDate,
          customer: inputData.customer as string,
        } as any);

        return {
          posts: (posts || []).map((post: any) => ({
            id: post.id,
            content: post.content,
            publishDate: post.publishDate
              ? new Date(post.publishDate).toISOString()
              : undefined,
            state: post.state,
            group: post.group,
            integrationId: post.integrationId,
          })),
        };
      },
    });
  }
}
