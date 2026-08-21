import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { organizationFromContext } from '@gitroom/nestjs-libraries/chat/tools/comment.context';

@Injectable()
export class CommentPostListTool implements AgentToolInterface {
  constructor(private _integrationService: IntegrationService) {}
  name = 'commentPostList';

  run() {
    return createTool({
      id: 'commentPostList',
      description: `List the posts of a channel that can have their comments moderated, including its ads. Use the integrationList tool first to get the channel id. Returns the post ids needed by the commentList tool, newest first within a page — ads are listed alongside organic posts and an older ad can appear on an earlier page than a newer organic post. \`isAd\` marks a post that is an ad — ads only appear when the channel granted the ads permission. Only some platforms support this (Facebook, Instagram, TikTok Business; TikTok Business is organic posts only).`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('Channel id from the integrationList tool'),
        limit: z
          .number()
          .optional()
          .describe('How many posts to return, default 30'),
        cursor: z
          .string()
          .optional()
          .describe('The `next` value from a previous call, to get more posts'),
      }),
      mcp: {
        annotations: {
          title: 'List Posts With Comments',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      outputSchema: z.object({
        posts: z.array(
          z.object({
            id: z.string(),
            content: z.string(),
            publishDate: z.string(),
            url: z.string().optional(),
            commentCount: z.number().optional(),
            likeCount: z.number().optional(),
            isAd: z.boolean().optional(),
          })
        ),
        // TikTok Business is served from a cache that fills in the background,
        // so an agent needs to know the list may still be incomplete.
        syncing: z.boolean().optional(),
        next: z.string().optional(),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = organizationFromContext(context);

        const page = await this._integrationService.fetchCommentPosts(
          organizationId,
          inputData.integrationId,
          inputData.limit || 30,
          inputData.cursor
        );

        return {
          posts: (page.posts || []).map((post) => ({
            id: post.id,
            content: post.content,
            publishDate: post.publishDate,
            url: post.releaseURL,
            commentCount: post.commentCount,
            likeCount: post.likeCount,
            isAd: post.isAd,
          })),
          syncing: page.syncing,
          next: page.next,
        };
      },
    });
  }
}
