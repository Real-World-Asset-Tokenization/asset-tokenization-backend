/**
 * Notification Service
 * Implements console-based notifications for development.
 * In production, this should be replaced with email/SMS/WebSocket notifications.
 */

class NotificationService {
  /**
   * Send approval notification to asset owner
   */
  async sendApprovalNotification(assetOwnerId, assetId, assetName) {
    console.log(`\n=== NOTIFICATION: ASSET APPROVED ===`);
    console.log(`Recipient: Asset Owner ID ${assetOwnerId}`);
    console.log(`Asset ID: ${assetId}`);
    console.log(`Asset Name: ${assetName}`);
    console.log(`Message: Your asset "${assetName}" has been approved for tokenization.`);
    console.log(`Message: Please review and provide your consent to proceed with tokenization.`);
    console.log(`===================================\n`);
  }

  /**
   * Send tokenization request notification to asset owner
   */
  async sendTokenizationRequestNotification(assetOwnerId, assetId, assetName) {
    console.log(`\n=== NOTIFICATION: TOKENIZATION REQUEST ===`);
    console.log(`Recipient: Asset Owner ID ${assetOwnerId}`);
    console.log(`Asset ID: ${assetId}`);
    console.log(`Asset Name: ${assetName}`);
    console.log(`Message: Your asset "${assetName}" is ready for tokenization.`);
    console.log(`Message: Please provide your consent to proceed with SPV creation and ownership transfer.`);
    console.log(`=====================================\n`);
  }

  /**
   * Send SPV creation notification to asset owner
   */
  async sendSPVCreationNotification(assetOwnerId, assetId, spvDetails) {
    console.log(`\n=== NOTIFICATION: SPV CREATED ===`);
    console.log(`Recipient: Asset Owner ID ${assetOwnerId}`);
    console.log(`Asset ID: ${assetId}`);
    console.log(`SPV Name: ${spvDetails.spvName}`);
    console.log(`SPV Registration Number: ${spvDetails.spvRegistrationNumber}`);
    console.log(`SPV Address: ${spvDetails.spvAddress}`);
    console.log(`Message: An SPV has been created for your asset.`);
    console.log(`Message: Ownership transfer will now be initiated.`);
    console.log(`==============================\n`);
  }

  /**
   * Send ownership transfer notification to asset owner
   */
  async sendOwnershipTransferNotification(assetOwnerId, assetId, assetName) {
    console.log(`\n=== NOTIFICATION: OWNERSHIP TRANSFERRED ===`);
    console.log(`Recipient: Asset Owner ID ${assetOwnerId}`);
    console.log(`Asset ID: ${assetId}`);
    console.log(`Asset Name: ${assetName}`);
    console.log(`Message: Ownership of your asset "${assetName}" has been transferred to the company via SPV.`);
    console.log(`Message: Blockchain tokenization will now be initiated.`);
    console.log(`=======================================\n`);
  }

  /**
   * Send tokenization completion notification to asset owner
   */
  async sendTokenizationCompleteNotification(assetOwnerId, assetId, assetName) {
    console.log(`\n=== NOTIFICATION: TOKENIZATION COMPLETE ===`);
    console.log(`Recipient: Asset Owner ID ${assetOwnerId}`);
    console.log(`Asset ID: ${assetId}`);
    console.log(`Asset Name: ${assetName}`);
    console.log(`Message: Your asset "${assetName}" has been successfully tokenized on the blockchain.`);
    console.log(`Message: Fractional shares are now available for investors.`);
    console.log(`========================================\n`);
  }

  /**
   * Send rejection notification to asset owner
   */
  async sendRejectionNotification(assetOwnerId, assetId, assetName, reason) {
    console.log(`\n=== NOTIFICATION: ASSET REJECTED ===`);
    console.log(`Recipient: Asset Owner ID ${assetOwnerId}`);
    console.log(`Asset ID: ${assetId}`);
    console.log(`Asset Name: ${assetName}`);
    console.log(`Reason: ${reason}`);
    console.log(`Message: Your asset "${assetName}" has been rejected.`);
    console.log(`=================================\n`);
  }
}

export default new NotificationService();
