import { readProfile, scoreProfile } from "../services/recommendationService.js";

export async function matchListings(req, res, next) {
  try {
    const profile = readProfile(req.body);
    const data = await scoreProfile(profile);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}
