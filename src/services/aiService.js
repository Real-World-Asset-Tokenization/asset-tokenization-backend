import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:5001';

class AIService {
  // ── Standalone: OCR for ID documents ──────────────────────────────────────
  async extractTextFromDocument(documentPath) {
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(documentPath));

      const response = await axios.post(`${AI_SERVICE_URL}/ocr`, formData, {
        headers: formData.getHeaders(),
      });

      return response.data;
    } catch (error) {
      console.error('OCR Error:', error.message);
      throw new Error('Failed to extract text from document');
    }
  }

  // ── Standalone: Face verification ──────────────────────────────────────────
  async verifyFaces(selfiePath, documentPath) {
    try {
      const formData = new FormData();
      formData.append('selfie', fs.createReadStream(selfiePath));
      formData.append('document', fs.createReadStream(documentPath));

      const response = await axios.post(`${AI_SERVICE_URL}/face-verify`, formData, {
        headers: formData.getHeaders(),
      });

      return response.data;
    } catch (error) {
      console.error('Face Verification Error:', error.message);
      throw new Error('Failed to verify faces');
    }
  }

  // ── Standalone: Document forgery detection ────────────────────────────────
  async detectForgery(documentPath) {
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(documentPath));

      const response = await axios.post(`${AI_SERVICE_URL}/detect-forgery`, formData, {
        headers: formData.getHeaders(),
      });

      return response.data;
    } catch (error) {
      console.error('Forgery Detection Error:', error.message);
      throw new Error('Failed to detect forgery');
    }
  }

  // ── Standalone: OCR for asset documents ──────────────────────────────────
  async extractAssetData(documentPath) {
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(documentPath));

      const response = await axios.post(`${AI_SERVICE_URL}/asset-ocr`, formData, {
        headers: formData.getHeaders(),
      });

      return response.data;
    } catch (error) {
      console.error('Asset OCR Error:', error.message);
      throw new Error('Failed to extract asset data');
    }
  }

  // ── PIPELINE: Full KYC verification (4 stages in one call) ────────────────
  /**
   * Run the full KYC verification pipeline on the AI service.
   *
   * The pipeline executes sequentially:
   *   Stage 1 — Image clarity check (document + selfie)
   *   Stage 2 — National ID OCR extraction
   *   Stage 3 — Face similarity detection
   *   Stage 4 — Risk analysis & decision
   *
   * @param {string} documentPath  Absolute path to the ID document image
   * @param {string} selfiePath    Absolute path to the selfie image
   * @returns {Promise<Object>}    Full pipeline result object from the AI service
   */
  async runKYCPipeline(documentPath, selfiePath) {
    try {
      const formData = new FormData();
      formData.append('document', fs.createReadStream(documentPath));
      formData.append('selfie', fs.createReadStream(selfiePath));

      const response = await axios.post(
        `${AI_SERVICE_URL}/pipeline/verify`,
        formData,
        {
          headers: formData.getHeaders(),
          // Allow up to 5 minutes — face verification can be slow on CPU
          timeout: 300000,
        }
      );

      return response.data;
    } catch (error) {
      console.error('KYC Pipeline Error:', error.message);
      throw new Error(`KYC pipeline failed: ${error.message}`);
    }
  }

  // ── PIPELINE: Full asset document verification (6 stages in one call) ─────
  /**
   * Run the full asset document verification pipeline on the AI service.
   *
   * The pipeline executes sequentially:
   *   Stage 1 — Image clarity check
   *   Stage 2 — AI generation detection (metadata inspection)
   *   Stage 3 — Manipulation detection (ELA)
   *   Stage 4 — Perceptual hash computation
   *   Stage 5 — OCR extraction
   *   Stage 6 — Risk analysis & decision
   *
   * @param {string} documentPath  Absolute path to the asset document image
   * @returns {Promise<Object>}    Full pipeline result object from the AI service
   */
  async runAssetDocumentPipeline(documentPath) {
    try {
      const formData = new FormData();
      formData.append('document', fs.createReadStream(documentPath));

      const response = await axios.post(
        `${AI_SERVICE_URL}/pipeline/asset-verify`,
        formData,
        {
          headers: formData.getHeaders(),
          // Allow up to 5 minutes for processing
          timeout: 300000,
        }
      );

      return response.data;
    } catch (error) {
      console.error('Asset Document Pipeline Error:', error.message);
      throw new Error(`Asset document pipeline failed: ${error.message}`);
    }
  }

  // ── Health check ───────────────────────────────────────────────────────────
  async healthCheck() {
    try {
      const response = await axios.get(`${AI_SERVICE_URL}/health`);
      return response.data;
    } catch (error) {
      console.error('AI Service Health Check Error:', error.message);
      throw new Error('AI service is not available');
    }
  }
}

export default new AIService();
