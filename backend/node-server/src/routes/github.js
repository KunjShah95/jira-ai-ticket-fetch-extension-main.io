import express from 'express';
import { body, validationResult } from 'express-validator';
import { authenticateToken } from '../middleware/auth.js';
import { GitHubService } from '../services/GitHubService.js';
import { createLogger } from '../utils/logger.js';
import { setUserGitHubToken } from '../utils/githubTokenStore.js';

const router = express.Router();
const logger = createLogger();

/**
 * POST /api/github/commit
 * Create commit with generated code and tests
 */
router.post('/commit',
	authenticateToken,
	[
		body('files').isArray().withMessage('Files array is required'),
		body('files.*.path').notEmpty().withMessage('File path is required'),
		body('files.*.content').notEmpty().withMessage('File content is required'),
		body('commitMessage').notEmpty().withMessage('Commit message is required'),
		body('branchName').notEmpty().withMessage('Branch name is required'),
		body('ticketKey').notEmpty().withMessage('Jira ticket key is required')
	],
	async (req, res, next) => {
		try {
			const errors = validationResult(req);
			if (!errors.isEmpty()) {
				return res.status(400).json({
					error: 'Validation Error',
					details: errors.array()
				});
			}

			const { files, commitMessage, branchName, ticketKey, baseBranch = 'main' } = req.body;
			const githubService = new GitHubService(req.user.jiraAccountId);

			logger.info('Creating GitHub commit', {
				branchName,
				fileCount: files.length,
				ticketKey,
				userId: req.user.jiraAccountId
			});

			// Create branch if it doesn't exist
			await githubService.createBranch(branchName, baseBranch);

			// Create commit with all files
			const commitResult = await githubService.createCommit(
				branchName,
				commitMessage,
				files
			);

			logger.info('GitHub commit created successfully', {
				branchName,
				commitSha: commitResult.sha,
				ticketKey
			});

			res.json({
				success: true,
				data: {
					commit: commitResult,
					branch: branchName,
					files: files.map(f => ({ path: f.path, size: f.content.length }))
				},
				message: 'Code committed successfully to GitHub',
				metadata: {
					ticketKey,
					commitSha: commitResult.sha,
					branchName,
					fileCount: files.length
				}
			});
		} catch (error) {
			logger.error('Failed to create GitHub commit', {
				error: error.message,
				ticketKey: req.body?.ticketKey
			});
			next(error);
		}
	}
);

/**
 * POST /api/github/pull-request
 * Create a pull request for the generated code
 */
router.post('/pull-request',
	authenticateToken,
	[
		body('title').notEmpty().withMessage('Pull request title is required'),
		body('branchName').notEmpty().withMessage('Branch name is required'),
		body('ticketKey').notEmpty().withMessage('Jira ticket key is required'),
		body('baseBranch').optional().isString().withMessage('Base branch must be a string')
	],
	async (req, res, next) => {
		try {
			const errors = validationResult(req);
			if (!errors.isEmpty()) {
				return res.status(400).json({
					error: 'Validation Error',
					details: errors.array()
				});
			}

			const {
				title,
				description = '',
				branchName,
				ticketKey,
				baseBranch = 'main',
				draft = false
			} = req.body;

			const githubService = new GitHubService(req.user.jiraAccountId);

			logger.info('Creating GitHub pull request', {
				title,
				branchName,
				baseBranch,
				ticketKey,
				userId: req.user.jiraAccountId
			});

			// Create pull request description with Jira link
			const jiraUrl = `${process.env.JIRA_BASE_URL}/browse/${ticketKey}`;
			const prDescription = `
${description}

## Related Jira Ticket
[${ticketKey}](${jiraUrl})

## Generated by Void Editor AI
This pull request was automatically generated based on the requirements in the Jira ticket.

### Changes Include:
- ✅ Production-ready code implementation
- ✅ Comprehensive unit tests
- ✅ Integration tests
- ✅ Documentation updates

### Next Steps:
1. Review the generated code
2. Run tests to verify functionality
3. Make any necessary adjustments
4. Merge when ready

---
*Generated on ${new Date().toISOString()} by Void Editor AI*
      `.trim();

			const pullRequest = await githubService.createPullRequest({
				title: `[${ticketKey}] ${title}`,
				head: branchName,
				base: baseBranch,
				body: prDescription,
				draft
			});

			logger.info('GitHub pull request created successfully', {
				prNumber: pullRequest.number,
				prUrl: pullRequest.html_url,
				ticketKey
			});

			res.json({
				success: true,
				data: pullRequest,
				message: 'Pull request created successfully',
				metadata: {
					ticketKey,
					prNumber: pullRequest.number,
					prUrl: pullRequest.html_url,
					branchName
				}
			});
		} catch (error) {
			logger.error('Failed to create GitHub pull request', {
				error: error.message,
				ticketKey: req.body?.ticketKey
			});
			next(error);
		}
	}
);

/**
 * GET /api/github/branches
 * List repository branches
 */
router.get('/branches', authenticateToken, async (req, res, next) => {
	try {
		const githubService = new GitHubService(req.user.jiraAccountId);
		const { protected: protectedOnly } = req.query;

		logger.info('Fetching GitHub branches', {
			protectedOnly: !!protectedOnly,
			userId: req.user.jiraAccountId
		});

		const branches = await githubService.getBranches(protectedOnly === 'true');

		res.json({
			success: true,
			data: branches,
			metadata: {
				count: branches.length,
				fetchedAt: new Date().toISOString()
			}
		});
	} catch (error) {
		logger.error('Failed to fetch GitHub branches', { error: error.message });
		next(error);
	}
});

/**
 * GET /api/github/repository/info
 * Get repository information
 */
router.get('/repository/info', authenticateToken, async (req, res, next) => {
	try {
		const githubService = new GitHubService(req.user.jiraAccountId);

		logger.info('Fetching GitHub repository info', {
			userId: req.user.jiraAccountId
		});

		const repoInfo = await githubService.getRepositoryInfo();

		res.json({
			success: true,
			data: repoInfo,
			metadata: {
				fetchedAt: new Date().toISOString()
			}
		});
	} catch (error) {
		logger.error('Failed to fetch GitHub repository info', { error: error.message });
		next(error);
	}
});

/**
 * POST /api/github/webhook
 * Handle GitHub webhooks for PR status updates
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
	try {
		const githubService = new GitHubService();
		const signature = req.headers['x-hub-signature-256'];
		const event = req.headers['x-github-event'];

		// Verify webhook signature (important for security)
		if (!githubService.verifyWebhookSignature(req.body, signature)) {
			return res.status(401).json({
				error: 'Unauthorized',
				message: 'Invalid webhook signature'
			});
		}

		const payload = JSON.parse(req.body.toString());

		logger.info('Received GitHub webhook', {
			event,
			action: payload.action,
			repository: payload.repository?.name
		});

		// Handle different webhook events
		switch (event) {
			case 'pull_request':
				await githubService.handlePullRequestWebhook(payload);
				break;
			case 'push':
				await githubService.handlePushWebhook(payload);
				break;
			default:
				logger.info('Unhandled webhook event', { event });
		}

		res.status(200).json({ message: 'Webhook processed successfully' });
	} catch (error) {
		logger.error('Failed to process GitHub webhook', { error: error.message });
		next(error);
	}
});

/**
 * POST /api/github/token
 * Store or update the user's GitHub API token (secure, never log or expose the token)
 * Body: { token: string }
 */
router.post('/token', authenticateToken, [
	body('token').notEmpty().withMessage('GitHub token is required')
], async (req, res, next) => {
	try {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({
				error: 'Validation Error',
				details: errors.array()
			});
		}
		// Store the token in-memory (replace with DB/secrets manager for production)
		setUserGitHubToken(req.user.jiraAccountId, req.body.token);
		logger.info('GitHub token updated for user', { userId: req.user.jiraAccountId });
		res.json({ success: true, message: 'GitHub token stored securely' });
	} catch (error) {
		next(error);
	}
});

export { router as githubRoutes };
