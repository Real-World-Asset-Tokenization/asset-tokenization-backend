from flask import Flask, request, jsonify
from flask_cors import CORS
import os
from werkzeug.utils import secure_filename
import uuid
import sys
from cloudinary_helper import upload_to_cloudinary, upload_image, upload_document

# Try to import AI libraries with error handling
try:
    import easyocr
    import cv2
    import numpy as np
    from deepface import DeepFace
    import re
    import pytesseract
    AI_AVAILABLE = True
except ImportError as e:
    print(f"Warning: AI libraries not fully available: {e}")
    print("Running in mock mode. Install with: pip install -r requirements.txt")
    AI_AVAILABLE = False

# Try to import additional libraries for asset verification
try:
    import issynthetic
    IS_SYNTHETIC_AVAILABLE = True
except ImportError as e:
    print(f"Warning: issynthetic not available: {e}")
    IS_SYNTHETIC_AVAILABLE = False

try:
    import imagehash
    from PIL import Image as PILImage
    IMAGEHASH_AVAILABLE = True
except ImportError as e:
    print(f"Warning: imagehash not available: {e}")
    IMAGEHASH_AVAILABLE = False

app = Flask(__name__)
CORS(app)

# Configuration
UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'pdf'}
MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB max file size

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# Create upload directory if it doesn't exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Initialize EasyOCR reader only if AI libraries are available
reader = None
if AI_AVAILABLE:
    try:
        # Initialize with English only
        reader = easyocr.Reader(['en'], gpu=False)
    except Exception as e:
        print(f"Warning: Failed to initialize EasyOCR: {e}")
        AI_AVAILABLE = False

def clean_text(text):
    """
    Clean OCR text by removing common artifacts
    """
    # Remove special characters and symbols
    text = re.sub(r'[^\w\s\u0d80-\u0dff\u0e00-\u0e7f]', ' ', text)
    # Remove multiple spaces
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

def extract_id_info(text):
    """
    Extract Name, Date of Birth, ID Number, Sex, Address, Date of Issue, and Place of Birth from OCR text
    """
    result = {
        'fullName': None,
        'idNumber': None,
        'dateOfBirth': None,
        'sex': None,
        'address': None,
        'dateOfIssue': None,
        'placeOfBirth': None
    }
    
    # Filter out non-English characters (keep only ASCII)
    text = re.sub(r'[^\x00-\x7F]+', ' ', text)
    text_upper = text.upper()
    
    # Extract ID number (Sri Lankan ID format - 10-12 digits)
    id_patterns = [
        r'NO[.:]\\s*/\\s*(\\d{10,12})',
        r'NO[.:]\\s*(\\d{10,12})',
        r'ID\\s*NO[.:]\\s*(\\d{10,12})',
        r'NO\\.\\s*(\\d{10,12})',
        r'\\d{10,12}[VX]?',
    ]
    
    for pattern in id_patterns:
        match = re.search(pattern, text_upper)
        if match:
            result['idNumber'] = match.group(1) if match.lastindex else match.group()
            result['idNumber'] = re.sub(r'[^0-9VX]', '', result['idNumber'])
            if len(result['idNumber']) >= 10:
                break
    
    # Fallback for ID number - find longest 10+ digit sequence
    if not result['idNumber']:
        all_numbers = re.findall(r'\d{8,}', text_upper)
        for num in all_numbers:
            num_clean = re.sub(r'[^0-9VX]', '', num)
            if len(num_clean) >= 10 and len(num_clean) <= 12:
                result['idNumber'] = num_clean
                break
    
    # Extract date of birth
    dob_patterns = [
        r'DATE\s*OF\s*BIRTH[:\s]*(\d{2}[/\s-]\d{2}[/\s-]\d{4})',
        r'DATE\s*OF\s*BIRTH[:\s]*(\d{4}[/\s-]\d{2}[/\s-]\d{2})',
        r'(?:DOB|DATE OF BIRTH|BIRTH|DAUTE OF BIRTH)[:\s]*(\d{4}[/\s-]\d{2}[/\s-]\d{2}|\d{2}[/\s-]\d{2}[/\s-]\d{4})',
        r'(\d{4})[/\s-](\d{2})[/\s-](\d{2})',
        r'(\d{2})[/\s-](\d{2})[/\s-](\d{4})',
    ]
    for pattern in dob_patterns:
        match = re.search(pattern, text_upper)
        if match:
            date_str = match.group(1) if match.lastindex else match.group()
            if '/' in date_str or '-' in date_str or ' ' in date_str:
                parts = re.split(r'[/\s-]', date_str)
                if len(parts) == 3:
                    if len(parts[2]) == 4:
                        result['dateOfBirth'] = f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
                    else:
                        result['dateOfBirth'] = f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
            break
    
    # Extract sex - simple approach: look for MALE or FEMALE
    if 'MALE' in text_upper:
        result['sex'] = 'Male'
    elif 'FEMALE' in text_upper:
        result['sex'] = 'Female'
    
    # Extract name - more specific patterns
    name_patterns = [
        r'NAME\s*\*\s*([A-Z][A-Z\s]{15,})',  # NAME * followed by long name
        r'NAME\s*[:\*]\s*([A-Z][A-Z\s]{15,})',
        r'NAE\s*([A-Z][A-Z\s]{15,})',  # Handle OCR error "NAE" instead of "NAME"
        r'(?:NAME|FULL NAME|IN FULL)[:\s*]\*([A-Z\s]+)',
    ]
    
    for pattern in name_patterns:
        match = re.search(pattern, text_upper)
        if match:
            name = match.group(1).strip().title() if match.lastindex else match.group().strip().title()
            # Clean up common OCR errors and stop at common stop words
            stop_words = ['SEX', 'DATE', 'BIRTH', 'SIGNATURE', 'HOLDER', 'NATIONAL', 'IDENTITY', 'CARD', 'NO', 'ID']
            for stop_word in stop_words:
                if stop_word in name.upper():
                    name = name.upper().split(stop_word)[0].strip()
            name = name.title()
            name = re.sub(r'[^\w\s]', '', name)
            name = re.sub(r'\d+', '', name)
            if len(name) > 10 and len(name.split()) >= 2:
                result['fullName'] = name
                break
    
    # Fallback for name - look for longest sequence of capitalized words
    if not result['fullName']:
        lines = text.split('\n')
        for line in lines[:15]:
            words = line.strip().split()
            capitalized_words = [word for word in words if word[0].isupper() and word.isalpha() and len(word) > 2 and not any(c.isdigit() for c in word)]
            if len(capitalized_words) >= 3:
                name = ' '.join(capitalized_words).title()
                # Remove common non-name words
                name = re.sub(r'\b(National|Identity|Card|Sex|Date|Birth|Signature|Holder|No|Id)\b', '', name, flags=re.IGNORECASE)
                name = ' '.join(name.split())
                if len(name) > 10:
                    result['fullName'] = name
                    break
    
    # Extract address - look for address patterns with better stopping conditions
    address_patterns = [
        r'ADDRESS\s*[:\s]*(.*?)(?:\d{8,9}|DATE\s*OF\s*ISSUE|PLACE\s*OF\s*BIRTH|REGISTRATION|$)',
        r'PERMANENT\s*ADDRESS\s*[:\s]*(.*?)(?:\d{8,9}|DATE\s*OF\s*ISSUE|PLACE\s*OF\s*BIRTH|REGISTRATION|$)',
    ]
    for pattern in address_patterns:
        match = re.search(pattern, text_upper, re.DOTALL)
        if match:
            address = match.group(1).strip()
            # Clean up address - remove numbers that look like dates and garbage
            address = re.sub(r'\d{8,9}', '', address)
            address = re.sub(r'\s+\d+[/_]\s+\d+', '', address)  # Remove number patterns
            address = re.sub(r'[A-Z]{3,}\s+[A-Z]{3,}\s+\d+', '', address)  # Remove garbage patterns
            address = re.sub(r'\s+[A-Z]{3,}\s+[A-Z]{3,}', '', address)  # Remove random letter sequences
            address = re.sub(r'\s+', ' ', address)
            address = re.sub(r'[^\w\s,./-]', '', address)
            address = address.strip()
            # Keep only meaningful address parts
            address_parts = [part for part in address.split(',') if len(part.strip()) > 2]
            address = ', '.join(address_parts)
            if len(address) > 10:
                result['address'] = address.title()
                break
    
    # Extract date of issue - look for 8-digit format near "Date of Issue"
    issue_patterns = [
        r'DATE\s*OF\s*ISSUE.*?(\d{8})',
        r'ISSUE\s*DATE.*?(\d{8})',
        r'(\d{8})\s*DATE\s*OF\s*ISSUE',
    ]
    for pattern in issue_patterns:
        match = re.search(pattern, text_upper)
        if match:
            date_str = match.group(1)
            if len(date_str) == 8 and date_str.isdigit():
                result['dateOfIssue'] = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
                break
    
    # Extract place of birth - handle OCR errors like "Piace" instead of "Place"
    place_patterns = [
        r'PLACE\s*OF\s*BIRTH\s*[:\s]*([A-Z]+)',
        r'PIACE\s*OF\s*BIRTH\s*[:\s]*([A-Z]+)',  # Handle OCR error
        r'PLACE\s*BIRTH\s*[:\s]*([A-Z]+)',
        r'PIACE\s*BIRTH\s*[:\s]*([A-Z]+)',  # Handle OCR error
    ]
    for pattern in place_patterns:
        match = re.search(pattern, text_upper)
        if match:
            place = match.group(1).strip()
            place = re.sub(r'\s+', ' ', place)
            place = re.sub(r'[^\w\s]', '', place)
            # Fix common OCR errors
            if 'COLOVBO' in place:
                place = 'COLOMBO'
            elif 'COLOMBO' in place:
                place = 'COLOMBO'
            if len(place) > 3:
                result['placeOfBirth'] = place.title()
    
    return result

def preprocess_image(image_path):
    """
    Preprocess image for better OCR results
    """
    img = cv2.imread(image_path)
    if img is None:
        return None
    
    # Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Light denoising only
    denoised = cv2.fastNlMeansDenoising(gray, h=5)
    
    # Mild contrast enhancement
    clahe = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8,8))
    enhanced = clahe.apply(denoised)
    
    return enhanced


# =============================================================================
# SHARED HELPER: Image Clarity / Quality Check
# Used by Stage 1 of the pipeline AND the standalone /detect-forgery endpoint
# =============================================================================

def check_image_clarity(image_path):
    """
    Assess image clarity and quality for KYC purposes.

    Checks performed:
      - Resolution (min 300x300)
      - Blur (Laplacian variance)
      - Noise level (std deviation)
      - Brightness (too dark / overexposed)
      - Edge density (blank / featureless images)
      - Compression artifacts (large images)

    Returns:
        {
          'passed':       bool,       # True if quality >= 0.5 and no critical issues
          'qualityScore': float,      # 0.0 - 1.0
          'issues':       [str],      # Human-readable issue descriptions
          'details':      dict        # Raw metric values
        }
    """
    img = cv2.imread(image_path)
    if img is None:
        return {
            'passed': False,
            'qualityScore': 0.0,
            'issues': ['Unable to read image - file may be corrupt or unsupported'],
            'details': {}
        }

    issues = []
    quality_score = 1.0
    details = {}

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape

    # -- Resolution check --
    details['resolution'] = {'width': width, 'height': height}
    if width < 300 or height < 300:
        issues.append('Low resolution image (minimum 300x300 required)')
        quality_score -= 0.3

    # -- Blur check (Laplacian variance) --
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    details['blurScore'] = round(float(laplacian_var), 2)
    if laplacian_var < 30:
        issues.append('Image is severely blurry')
        quality_score -= 0.3
    elif laplacian_var < 60:
        issues.append('Image appears blurry')
        quality_score -= 0.2

    # -- Noise check --
    noise = float(np.std(gray))
    details['noiseLevel'] = round(noise, 2)
    if noise > 60:
        issues.append('High noise level detected')
        quality_score -= 0.15

    # -- Brightness check --
    mean_brightness = float(np.mean(gray))
    details['brightness'] = round(mean_brightness, 2)
    if mean_brightness < 50:
        issues.append('Image is too dark')
        quality_score -= 0.15
    elif mean_brightness > 220:
        issues.append('Image is overexposed / too bright')
        quality_score -= 0.1

    # -- Edge density (blank / featureless detection) --
    edges = cv2.Canny(gray, 50, 150)
    edge_density = float(np.sum(edges > 0)) / (width * height)
    details['edgeDensity'] = round(edge_density, 4)
    if edge_density < 0.005:
        issues.append('Unusually low edge content - image may be blank or featureless')
        quality_score -= 0.1

    # -- Compression artifact check (large images only) --
    if height > 800 and width > 800:
        small = cv2.resize(gray, (width // 4, height // 4))
        large = cv2.resize(small, (width, height))
        diff = cv2.absdiff(gray, large)
        artifact_score = float(np.mean(diff))
        details['artifactScore'] = round(artifact_score, 2)
        if artifact_score > 15:
            issues.append('Strong compression artifacts detected')
            quality_score -= 0.1

    quality_score = round(max(0.0, min(1.0, quality_score)), 2)

    # Critical issues that force failure regardless of score
    critical_keywords = ['severely', 'corrupt', 'Low resolution', 'Unable']
    has_critical = any(
        any(kw in issue for kw in critical_keywords) for issue in issues
    )
    passed = quality_score >= 0.5 and not has_critical

    return {
        'passed': passed,
        'qualityScore': quality_score,
        'issues': issues,
        'details': details
    }


def detect_document_forgery(image_path):
    """
    Detect potential document forgery using image analysis.
    Delegates to check_image_clarity for quality metrics.
    """
    clarity = check_image_clarity(image_path)
    manipulation_detected = not clarity['passed'] or clarity['qualityScore'] < 0.5

    return {
        'authentic': not manipulation_detected,
        'manipulationDetected': manipulation_detected,
        'qualityScore': clarity['qualityScore'],
        'issues': clarity['issues']
    }


def detect_ai_generation(image_path):
    """
    Detect AI-generated images using metadata inspection via issynthetic.
    Checks C2PA, EXIF, PNG chunks for AI generation metadata.
    """
    if IS_SYNTHETIC_AVAILABLE:
        try:
            result = issynthetic.inspect(image_path)
            return {
                'is_generated': result.is_generated if result.is_generated is not None else False,
                'confidence': result.confidence if result.confidence is not None else 0.0,
                'generator_name': result.generator_name,
                'details': result.details if hasattr(result, 'details') else {},
                'method': 'metadata_inspection'
            }
        except Exception as e:
            print(f"AI generation detection error: {e}")
            return {
                'is_generated': False,
                'confidence': 0.0,
                'generator_name': None,
                'details': {},
                'error': str(e),
                'method': 'metadata_inspection'
            }
    else:
        # Mock response
        return {
            'is_generated': False,
            'confidence': 0.0,
            'generator_name': None,
            'details': {},
            'note': 'Mock data - issynthetic not available',
            'method': 'mock'
        }


def compute_perceptual_hash(image_path, hash_type='phash', hash_size=16):
    """
    Compute perceptual hash of an image for duplicate detection.
    Supports: phash (default), dhash, ahash, whash
    """
    if IMAGEHASH_AVAILABLE:
        try:
            img = PILImage.open(image_path)
            
            if hash_type == 'phash':
                hash_value = imagehash.phash(img, hash_size=hash_size)
            elif hash_type == 'dhash':
                hash_value = imagehash.dhash(img, hash_size=hash_size)
            elif hash_type == 'ahash':
                hash_value = imagehash.average_hash(img, hash_size=hash_size)
            elif hash_type == 'whash':
                hash_value = imagehash.whash(img, hash_size=hash_size)
            else:
                hash_value = imagehash.phash(img, hash_size=hash_size)
            
            return {
                'hash': str(hash_value),
                'hash_type': hash_type,
                'hash_size': hash_size,
                'success': True
            }
        except Exception as e:
            print(f"Perceptual hash computation error: {e}")
            return {
                'hash': None,
                'hash_type': hash_type,
                'hash_size': hash_size,
                'success': False,
                'error': str(e)
            }
    else:
        # Mock response
        import hashlib
        with open(image_path, 'rb') as f:
            mock_hash = hashlib.md5(f.read()).hexdigest()[:16]
        return {
            'hash': mock_hash,
            'hash_type': 'mock_md5',
            'hash_size': 16,
            'success': True,
            'note': 'Mock hash - imagehash not available'
        }


def detect_manipulation_ela(image_path):
    """
    Detect image manipulation using Error Level Analysis (ELA).
    ELA highlights regions with different compression levels.
    """
    try:
        img = cv2.imread(image_path)
        if img is None:
            return {
                'manipulationDetected': False,
                'confidence': 0.0,
                'error': 'Unable to read image'
            }
        
        # Save image at a known quality
        ela_path = image_path + '_ela.jpg'
        cv2.imwrite(ela_path, img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        
        # Read the compressed image
        ela_img = cv2.imread(ela_path)
        
        # Calculate absolute difference
        diff = cv2.absdiff(img, ela_img)
        
        # Convert to grayscale and scale
        diff_gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
        diff_scaled = cv2.convertScaleAbs(diff_gray, alpha=25.5)
        
        # Calculate manipulation score based on ELA variance
        ela_variance = float(np.var(diff_scaled))
        
        # Clean up
        import os
        if os.path.exists(ela_path):
            os.remove(ela_path)
        
        # Higher variance suggests manipulation
        manipulation_score = min(1.0, ela_variance / 100.0)
        
        return {
            'manipulationDetected': manipulation_score > 0.3,
            'confidence': round(manipulation_score, 2),
            'elaVariance': round(ela_variance, 2),
            'method': 'error_level_analysis'
        }
    except Exception as e:
        print(f"ELA manipulation detection error: {e}")
        return {
            'manipulationDetected': False,
            'confidence': 0.0,
            'error': str(e),
            'method': 'error_level_analysis'
        }


def extract_asset_info(text):
    """
    Extract structured information from asset ownership documents
    """
    result = {
        'ownerName': None,
        'propertyNumber': None,
        'registrationNumber': None,
        'governmentAuthority': None,
        'propertyAddress': None,
        'marketValue': None,
        'documentDate': None
    }
    
    text_upper = text.upper()
    
    # Extract owner name
    owner_patterns = [
        r'(?:OWNER|OWNER NAME|PROPERTY OWNER|REGISTERED OWNER)[:\s]*([A-Z\s]+)',
    ]
    for pattern in owner_patterns:
        match = re.search(pattern, text_upper)
        if match:
            result['ownerName'] = match.group(1).strip().title()
            break
    
    # Extract property number
    prop_patterns = [
        r'(?:PROPERTY NO|PROPERTY NUMBER|PROP NO|LOT NO)[:\s]*([A-Z0-9-]+)',
        r'(?:PROP|LOT)[:\s]*([A-Z0-9-]+)',
    ]
    for pattern in prop_patterns:
        match = re.search(pattern, text_upper)
        if match:
            result['propertyNumber'] = match.group(1).strip()
            break
    
    # Extract registration number
    reg_patterns = [
        r'(?:REGISTRATION NO|REG NO|REGISTRATION NUMBER|REG NO\.?)[:\s]*([A-Z0-9-]+)',
    ]
    for pattern in reg_patterns:
        match = re.search(pattern, text_upper)
        if match:
            result['registrationNumber'] = match.group(1).strip()
            break
    
    # Extract government authority
    authority_patterns = [
        r'(?:AUTHORITY|DEPARTMENT|MINISTRY|REGISTRY)[:\s]*([A-Z\s]+)',
    ]
    for pattern in authority_patterns:
        match = re.search(pattern, text_upper)
        if match:
            result['governmentAuthority'] = match.group(1).strip().title()
            break
    
    # Extract property address
    address_keywords = ['ADDRESS', 'PROPERTY ADDRESS', 'LOCATION', 'SITUATED AT']
    lines = text.split('\n')
    address_lines = []
    for i, line in enumerate(lines):
        if any(keyword in line.upper() for keyword in address_keywords):
            address_lines.append(line.strip())
            for j in range(i+1, min(i+4, len(lines))):
                if lines[j].strip() and len(lines[j].strip()) > 5:
                    address_lines.append(lines[j].strip())
                else:
                    break
            break
    if address_lines:
        result['propertyAddress'] = ', '.join(address_lines).title()
    
    # Extract market value
    value_patterns = [
        r'(?:VALUE|MARKET VALUE|VALUATION|AMOUNT)[:\s]*[$]?\s*([\d,]+(?:\.\d{2})?)',
        r'\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:USD|DOLLARS)',
    ]
    for pattern in value_patterns:
        match = re.search(pattern, text_upper)
        if match:
            result['marketValue'] = match.group(1).replace(',', '')
            break
    
    # Extract document date
    date_patterns = [
        r'(?:DATE|DOCUMENT DATE|ISSUED|REGISTERED)[:\s]*(\d{4}-\d{2}-\d{2}|\d{2}/\d{2}/\d{4})',
    ]
    for pattern in date_patterns:
        match = re.search(pattern, text_upper)
        if match:
            date_str = match.group(1)
            if '/' in date_str or '-' in date_str:
                parts = re.split(r'[/-]', date_str)
                if len(parts) == 3:
                    if len(parts[2]) == 4:
                        result['documentDate'] = f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
                    else:
                        result['documentDate'] = f"{parts[0]}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
            break
    
    return result


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# =============================================================================
# PIPELINE STAGE 4: Risk Analysis Engine
# =============================================================================

def run_risk_analysis(doc_clarity, selfie_clarity, ocr_data, face_result):
    """
    Compute a weighted trust/risk score from all pipeline stage results.

    Scoring weights (total 100 pts):
        Document clarity     20 pts  (qualityScore * 20)
        Selfie clarity       10 pts  (qualityScore * 10)
        OCR completeness     20 pts  (fields extracted / 7 * 20)
        Face similarity      30 pts  (similarityScore / 100 * 30)
        Document authentic   20 pts  (passed=True -> 20, else 0)

    Decision thresholds:
        >= 80  -> approved
        60-79  -> under_review
        < 60   -> rejected
    """
    factors = {}
    total_score = 0.0

    # -- Document clarity (20 pts) --
    doc_quality = doc_clarity.get('qualityScore', 0.0)
    doc_pts = round(doc_quality * 20, 2)
    factors['documentClarity'] = {
        'score': doc_pts,
        'maxScore': 20,
        'qualityScore': doc_quality,
        'issues': doc_clarity.get('issues', [])
    }
    total_score += doc_pts

    # -- Selfie clarity (10 pts) --
    selfie_quality = selfie_clarity.get('qualityScore', 0.0)
    selfie_pts = round(selfie_quality * 10, 2)
    factors['selfieClarity'] = {
        'score': selfie_pts,
        'maxScore': 10,
        'qualityScore': selfie_quality,
        'issues': selfie_clarity.get('issues', [])
    }
    total_score += selfie_pts

    # -- OCR completeness (20 pts) --
    ocr_fields = ['fullName', 'idNumber', 'dateOfBirth', 'sex', 'address', 'dateOfIssue', 'placeOfBirth']
    extracted_count = sum(1 for f in ocr_fields if ocr_data.get(f))
    ocr_ratio = extracted_count / len(ocr_fields)
    ocr_pts = round(ocr_ratio * 20, 2)
    factors['ocrCompleteness'] = {
        'score': ocr_pts,
        'maxScore': 20,
        'fieldsExtracted': extracted_count,
        'totalFields': len(ocr_fields),
        'completenessRatio': round(ocr_ratio, 2)
    }
    total_score += ocr_pts

    # -- Face similarity (30 pts) --
    similarity = face_result.get('similarityScore', 0.0)
    face_pts = round((similarity / 100.0) * 30, 2)
    factors['faceSimilarity'] = {
        'score': face_pts,
        'maxScore': 30,
        'similarityScore': similarity,
        'match': face_result.get('match', False),
        'confidence': face_result.get('confidence', 'low')
    }
    total_score += face_pts

    # -- Document authenticity (20 pts) --
    doc_authentic = doc_clarity.get('passed', False)
    auth_pts = 20.0 if doc_authentic else 0.0
    factors['documentAuthenticity'] = {
        'score': auth_pts,
        'maxScore': 20,
        'authentic': doc_authentic
    }
    total_score += auth_pts

    total_score = round(min(100.0, total_score), 2)

    if total_score >= 80:
        decision = 'approved'
        risk_level = 'low'
    elif total_score >= 60:
        decision = 'under_review'
        risk_level = 'medium'
    else:
        decision = 'rejected'
        risk_level = 'high'

    return {
        'riskScore': total_score,
        'riskLevel': risk_level,
        'decision': decision,
        'factors': factors
    }


def run_asset_risk_analysis(doc_clarity, ai_gen_result, manipulation_result, ocr_data, is_duplicate):
    """
    Compute a weighted trust/risk score for asset document verification.

    Scoring weights (total 100 pts):
        Document clarity     20 pts  (qualityScore * 20)
        Not AI-generated    25 pts  (is_generated=False -> 25, else 0)
        Not manipulated     25 pts  (manipulationDetected=False -> 25, else 0)
        Not duplicate       20 pts  (is_duplicate=False -> 20, else 0)
        OCR completeness   10 pts  (fields extracted / 7 * 10)

    Decision thresholds:
        >= 80  -> approved
        60-79  -> under_review
        < 60   -> rejected
    """
    factors = {}
    total_score = 0.0

    # -- Document clarity (20 pts) --
    doc_quality = doc_clarity.get('qualityScore', 0.0)
    doc_pts = round(doc_quality * 20, 2)
    factors['documentClarity'] = {
        'score': doc_pts,
        'maxScore': 20,
        'qualityScore': doc_quality,
        'issues': doc_clarity.get('issues', [])
    }
    total_score += doc_pts

    # -- Not AI-generated (25 pts) --
    is_ai_generated = ai_gen_result.get('is_generated', False)
    ai_pts = 0.0 if is_ai_generated else 25.0
    factors['aiGenerationCheck'] = {
        'score': ai_pts,
        'maxScore': 25,
        'is_generated': is_ai_generated,
        'confidence': ai_gen_result.get('confidence', 0.0),
        'generator_name': ai_gen_result.get('generator_name')
    }
    total_score += ai_pts

    # -- Not manipulated (25 pts) --
    is_manipulated = manipulation_result.get('manipulationDetected', False)
    manipulation_pts = 0.0 if is_manipulated else 25.0
    factors['manipulationCheck'] = {
        'score': manipulation_pts,
        'maxScore': 25,
        'manipulationDetected': is_manipulated,
        'confidence': manipulation_result.get('confidence', 0.0),
        'method': manipulation_result.get('method', 'unknown')
    }
    total_score += manipulation_pts

    # -- Not duplicate (20 pts) --
    duplicate_pts = 0.0 if is_duplicate else 20.0
    factors['duplicateCheck'] = {
        'score': duplicate_pts,
        'maxScore': 20,
        'is_duplicate': is_duplicate
    }
    total_score += duplicate_pts

    # -- OCR completeness (10 pts) --
    ocr_fields = ['ownerName', 'propertyNumber', 'registrationNumber', 'governmentAuthority', 'propertyAddress', 'marketValue', 'documentDate']
    extracted_count = sum(1 for f in ocr_fields if ocr_data.get(f))
    ocr_ratio = extracted_count / len(ocr_fields) if len(ocr_fields) > 0 else 0
    ocr_pts = round(ocr_ratio * 10, 2)
    factors['ocrCompleteness'] = {
        'score': ocr_pts,
        'maxScore': 10,
        'fieldsExtracted': extracted_count,
        'totalFields': len(ocr_fields),
        'completenessRatio': round(ocr_ratio, 2)
    }
    total_score += ocr_pts

    total_score = round(min(100.0, total_score), 2)

    if total_score >= 80:
        decision = 'approved'
        risk_level = 'low'
    elif total_score >= 60:
        decision = 'under_review'
        risk_level = 'medium'
    else:
        decision = 'rejected'
        risk_level = 'high'

    return {
        'riskScore': total_score,
        'riskLevel': risk_level,
        'decision': decision,
        'factors': factors
    }


def _cleanup(paths):
    """Remove temporary files silently."""
    for p in paths:
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except Exception:
            pass


# =============================================================================
# ROUTES
# =============================================================================

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'service': 'AI Service',
        'version': '2.0.0',
        'aiAvailable': AI_AVAILABLE,
        'issyntheticAvailable': IS_SYNTHETIC_AVAILABLE,
        'imagehashAvailable': IMAGEHASH_AVAILABLE
    })

@app.route('/ocr', methods=['POST'])
def ocr():
    """
    Extract text from document image(s) using EasyOCR
    Accepts single file or multiple files (front and back of ID card)
    """
    # Check for single file or multiple files
    files = request.files.getlist('files') if 'files' in request.files else []
    single_file = request.files.get('file') if 'file' in request.files else None
    
    # Use single file if no multiple files provided
    if not files and single_file:
        files = [single_file]
    
    if not files or all(f.filename == '' for f in files):
        return jsonify({'error': 'No file provided'}), 400
    
    uploaded_files = []
    full_text = ""
    ocr_method = ""
    
    try:
        # Process each uploaded file
        for file in files:
            if file and allowed_file(file.filename):
                filename = secure_filename(str(uuid.uuid4()) + '_' + file.filename)
                filepath = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], filename))
                
                # Save file and verify it exists
                file.save(filepath)
                if not os.path.exists(filepath):
                    print(f"ERROR: File was not saved: {filepath}")
                    return jsonify({'error': f'Failed to save file: {filename}'}), 500
                
                print(f"File saved successfully: {filepath}")
                print(f"File size: {os.path.getsize(filepath)} bytes")
                uploaded_files.append(filepath)
                
                # Use EasyOCR as primary method BEFORE uploading to Cloudinary
                if AI_AVAILABLE and reader:
                    try:
                        print(f"Starting OCR for file: {filepath}")
                        ocr_result = reader.readtext(filepath)
                        file_text = ' '.join([text[1] for text in ocr_result])
                        full_text += file_text + " "
                        ocr_method = "EasyOCR"
                        print(f"Processed file: {filename}, extracted text length: {len(file_text)}")
                    except Exception as e:
                        print(f"EasyOCR failed for {filename}: {e}")
                        import traceback
                        traceback.print_exc()
                
                # Upload to Cloudinary AFTER OCR (this will delete the file)
                cloudinary_result = upload_image(filepath, 'kyc-ocr-temp')
                if cloudinary_result['success']:
                    print(f"Uploaded to Cloudinary: {cloudinary_result['url']}")
        
        full_text = full_text.strip()
        
        if not full_text:
            # Fallback to mock data
            result = {
                'success': True,
                'data': {
                    'fullName': 'John Doe',
                    'idNumber': '123456789V',
                    'dateOfBirth': '1990-01-01',
                    'sex': 'Male',
                    'address': '123 Main Street',
                    'dateOfIssue': '2018-01-15',
                    'placeOfBirth': 'Colombo'
                },
                'note': 'Mock data - AI libraries not available'
            }
        else:
            # Extract structured information from combined OCR text
            extracted_data = extract_id_info(full_text)
            
            result = {
                'success': True,
                'data': extracted_data,
                'rawText': full_text,
                'ocrMethod': ocr_method,
                'filesProcessed': len(uploaded_files)
            }
            
            # Save extracted details to text file
            output_dir = 'extracted_data'
            os.makedirs(output_dir, exist_ok=True)
            output_file = os.path.join(output_dir, f'extraction_{uuid.uuid4()}.txt')
            
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write("=" * 50 + "\n")
                f.write("ID CARD EXTRACTION RESULTS\n")
                f.write("=" * 50 + "\n\n")
                f.write(f"OCR Method: {ocr_method}\n")
                f.write(f"Files Processed: {len(uploaded_files)}\n\n")
                f.write("-" * 30 + "\n")
                f.write("EXTRACTED FIELDS:\n")
                f.write("-" * 30 + "\n")
                for key, value in extracted_data.items():
                    if value:
                        f.write(f"{key}: {value}\n")
                    else:
                        f.write(f"{key}: Not detected\n")
                f.write("\n" + "-" * 30 + "\n")
                f.write("RAW OCR TEXT:\n")
                f.write("-" * 30 + "\n")
                f.write(full_text + "\n")
            
            print(f"Extracted data saved to: {output_file}")
        
        # Clean up uploaded files
        for filepath in uploaded_files:
            if os.path.exists(filepath):
                os.remove(filepath)
        
        return jsonify(result), 200
    except Exception as e:
        # Clean up uploaded files on error
        for filepath in uploaded_files:
            if os.path.exists(filepath):
                os.remove(filepath)
        return jsonify({'error': str(e)}), 500

@app.route('/face-verify', methods=['POST'])
def face_verify():
    """
    Verify if selfie matches ID document photo using DeepFace
    """
    if 'selfie' not in request.files or 'document' not in request.files:
        return jsonify({'error': 'Both selfie and document files required'}), 400
    
    selfie = request.files['selfie']
    document = request.files['document']
    
    if selfie.filename == '' or document.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if selfie and document and allowed_file(selfie.filename) and allowed_file(document.filename):
        selfie_filename = secure_filename(str(uuid.uuid4()) + '_selfie_' + selfie.filename)
        doc_filename = secure_filename(str(uuid.uuid4()) + '_doc_' + document.filename)
        
        selfie_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], selfie_filename))
        doc_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], doc_filename))
        
        selfie.save(selfie_path)
        document.save(doc_path)
        
        try:
            if AI_AVAILABLE:
                # Perform face verification using DeepFace BEFORE uploading to Cloudinary
                verification = DeepFace.verify(
                    img1_path=selfie_path,
                    img2_path=doc_path,
                    model_name='VGG-Face',
                    detector_backend='retinaface',
                    enforce_detection=False
                )
                
                similarity_score = verification.get('distance', 0)
                # Convert distance to similarity percentage (lower distance = higher similarity)
                similarity_percentage = max(0, min(100, (1 - similarity_score) * 100))
                
                # Determine match based on threshold
                match = verification.get('verified', False)
                
                # Determine confidence level
                if similarity_percentage >= 80:
                    confidence = 'high'
                elif similarity_percentage >= 60:
                    confidence = 'medium'
                else:
                    confidence = 'low'
                
                result = {
                    'success': True,
                    'data': {
                        'similarityScore': round(similarity_percentage, 2),
                        'match': match,
                        'confidence': confidence,
                        'distance': round(similarity_score, 4),
                        'selfieUrl': None,
                        'documentUrl': None
                    }
                }
            else:
                # Fallback to mock data
                result = {
                    'success': True,
                    'data': {
                        'similarityScore': 95.5,
                        'match': True,
                        'confidence': 'high'
                    },
                    'note': 'Mock data - AI libraries not available'
                }
            
            # Upload to Cloudinary AFTER processing (this will delete the files)
            selfie_cloudinary = upload_image(selfie_path, 'kyc-face-verify')
            doc_cloudinary = upload_image(doc_path, 'kyc-face-verify')
            
            # Update result with Cloudinary URLs if available
            if result['success'] and 'data' in result:
                result['data']['selfieUrl'] = selfie_cloudinary.get('url') if selfie_cloudinary.get('success') else None
                result['data']['documentUrl'] = doc_cloudinary.get('url') if doc_cloudinary.get('success') else None
            
            return jsonify(result), 200
        except Exception as e:
            # Clean up uploaded files on error
            if os.path.exists(selfie_path):
                os.remove(selfie_path)
            if os.path.exists(doc_path):
                os.remove(doc_path)
            return jsonify({'error': str(e)}), 500
    
    return jsonify({'error': 'Invalid file type'}), 400

@app.route('/detect-forgery', methods=['POST'])
def detect_forgery():
    """
    Detect document forgery using OpenCV and image analysis
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if file and allowed_file(file.filename):
        filename = secure_filename(str(uuid.uuid4()) + '_' + file.filename)
        filepath = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], filename))
        file.save(filepath)
        
        try:
            if AI_AVAILABLE:
                # Perform forgery detection using OpenCV BEFORE uploading to Cloudinary
                forgery_result = detect_document_forgery(filepath)
                
                result = {
                    'success': True,
                    'data': forgery_result
                }
            else:
                # Fallback to mock data
                result = {
                    'success': True,
                    'data': {
                        'authentic': True,
                        'manipulationDetected': False,
                        'qualityScore': 0.92,
                        'issues': []
                    },
                    'note': 'Mock data - AI libraries not available'
                }
            
            # Upload to Cloudinary AFTER processing (this will delete the file)
            cloudinary_result = upload_image(filepath, 'kyc-forgery-detection')
            
            return jsonify(result), 200
        except Exception as e:
            # Clean up uploaded file on error
            if os.path.exists(filepath):
                os.remove(filepath)
            return jsonify({'error': str(e)}), 500
    
    return jsonify({'error': 'Invalid file type'}), 400

@app.route('/asset-ocr', methods=['POST'])
def asset_ocr():
    """
    Extract information from asset ownership documents
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if file and allowed_file(file.filename):
        filename = secure_filename(str(uuid.uuid4()) + '_' + file.filename)
        filepath = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], filename))
        file.save(filepath)
        
        try:
            if AI_AVAILABLE and reader:
                # Perform OCR using EasyOCR BEFORE uploading to Cloudinary
                ocr_result = reader.readtext(filepath)
                
                # Combine all detected text
                full_text = ' '.join([text[1] for text in ocr_result])
                
                # Extract structured information from OCR text
                extracted_data = extract_asset_info(full_text)
                
                result = {
                    'success': True,
                    'data': extracted_data,
                    'rawText': full_text,
                    'documentUrl': None
                }
            else:
                # Fallback to mock data
                result = {
                    'success': True,
                    'data': {
                        'ownerName': 'John Doe',
                        'propertyNumber': 'PROP-12345',
                        'registrationNumber': 'REG-67890',
                        'governmentAuthority': 'Land Registry',
                        'propertyAddress': '123 Main Street',
                        'marketValue': '500000',
                        'documentDate': '2020-01-15'
                    },
                    'note': 'Mock data - AI libraries not available'
                }
            
            # Upload to Cloudinary AFTER processing (this will delete the file)
            cloudinary_result = upload_document(filepath, 'asset-documents')
            
            # Update result with Cloudinary URL if available
            if result['success'] and 'data' in result:
                result['documentUrl'] = cloudinary_result.get('url') if cloudinary_result.get('success') else None
            
            return jsonify(result), 200
        except Exception as e:
            # Clean up uploaded file on error
            if os.path.exists(filepath):
                os.remove(filepath)
            return jsonify({'error': str(e)}), 500
    
    return jsonify({'error': 'Invalid file type'}), 400


# =============================================================================
# ASSET DOCUMENT VERIFICATION PIPELINE
# POST /pipeline/asset-verify  —  runs all 6 stages sequentially in a single call
# =============================================================================

@app.route('/pipeline/asset-verify', methods=['POST'])
def pipeline_asset_verify():
    """
    Full asset document verification pipeline.

    Multipart form fields required:
        document  — Asset document image (png/jpg/jpeg/pdf)

    Pipeline stages (sequential, fail-fast on Stage 1 failure):
        Stage 1: Image clarity check
        Stage 2: AI generation detection (metadata inspection)
        Stage 3: Manipulation detection (ELA)
        Stage 4: Perceptual hash computation (for duplicate check by Node.js)
        Stage 5: OCR extraction
        Stage 6: Risk analysis & final decision

    Response structure:
    {
      "success":         bool,
      "pipelineVersion": "1.0.0",
      "finalDecision":   "approved" | "under_review" | "rejected",
      "abortedAt":       null | "stage1_clarity",
      "abortReason":     null | string,
      "stages": {
        "stage1_clarity": {
          "passed": bool,
          "qualityScore": float,
          "issues": [str],
          "details": dict
        },
        "stage2_ai_generation": {
          "is_generated": bool,
          "confidence": float,
          "generator_name": str | null,
          "method": str
        },
        "stage3_manipulation": {
          "manipulationDetected": bool,
          "confidence": float,
          "method": str
        },
        "stage4_hash": {
          "hash": str,
          "hash_type": str,
          "hash_size": int
        },
        "stage5_ocr": {
          "extractedData": dict,
          "rawText": str,
          "ocrMethod": str
        },
        "stage6_risk": {
          "riskScore": float (0-100),
          "riskLevel": "low" | "medium" | "high",
          "decision": "approved" | "under_review" | "rejected",
          "factors": dict
        }
      },
      "documentUrl": string | null
    }
    """
    if 'document' not in request.files:
        return jsonify({
            'error': 'Document file is required'
        }), 400

    document_file = request.files['document']

    if document_file.filename == '':
        return jsonify({'error': 'No file selected for document'}), 400

    if not allowed_file(document_file.filename):
        return jsonify({'error': 'Invalid file type. Allowed: png, jpg, jpeg, pdf'}), 400

    # Save uploaded file to disk for AI processing
    doc_filename = secure_filename(str(uuid.uuid4()) + '_asset_pipeline_' + document_file.filename)
    doc_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], doc_filename))
    document_file.save(doc_path)

    pipeline_result = {
        'success': False,
        'pipelineVersion': '1.0.0',
        'finalDecision': None,
        'abortedAt': None,
        'abortReason': None,
        'stages': {
            'stage1_clarity': None,
            'stage2_ai_generation': None,
            'stage3_manipulation': None,
            'stage4_hash': None,
            'stage5_ocr': None,
            'stage6_risk': None
        },
        'documentUrl': None
    }

    try:
        # ── STAGE 1: Image Clarity Check ─────────────────────────────────────
        print("[Asset Pipeline] Stage 1 — Image Clarity Check")

        if AI_AVAILABLE:
            doc_clarity = check_image_clarity(doc_path)
        else:
            # Mock mode fallback
            doc_clarity = {'passed': True, 'qualityScore': 0.92, 'issues': [], 'details': {}}

        pipeline_result['stages']['stage1_clarity'] = doc_clarity

        # Fail-fast: abort if document image is critically unusable
        if not doc_clarity['passed']:
            pipeline_result['abortedAt'] = 'stage1_clarity'
            pipeline_result['abortReason'] = (
                'Document image failed clarity check: ' + ', '.join(doc_clarity['issues'])
            )
            pipeline_result['finalDecision'] = 'rejected'
            _cleanup([doc_path])
            return jsonify(pipeline_result), 200

        print(f"[Asset Pipeline] Stage 1 PASSED — quality={doc_clarity['qualityScore']}")

        # ── STAGE 2: AI Generation Detection ────────────────────────────────
        print("[Asset Pipeline] Stage 2 — AI Generation Detection")

        ai_gen_result = detect_ai_generation(doc_path)
        pipeline_result['stages']['stage2_ai_generation'] = ai_gen_result

        print(f"[Asset Pipeline] Stage 2 DONE — is_generated={ai_gen_result['is_generated']}")

        # ── STAGE 3: Manipulation Detection ─────────────────────────────────
        print("[Asset Pipeline] Stage 3 — Manipulation Detection")

        manipulation_result = detect_manipulation_ela(doc_path)
        pipeline_result['stages']['stage3_manipulation'] = manipulation_result

        print(f"[Asset Pipeline] Stage 3 DONE — manipulation={manipulation_result['manipulationDetected']}")

        # ── STAGE 4: Perceptual Hash Computation ────────────────────────────
        print("[Asset Pipeline] Stage 4 — Perceptual Hash Computation")

        hash_result = compute_perceptual_hash(doc_path, hash_type='phash', hash_size=16)
        pipeline_result['stages']['stage4_hash'] = hash_result

        print(f"[Asset Pipeline] Stage 4 DONE — hash={hash_result['hash']}")

        # ── STAGE 5: OCR Extraction ─────────────────────────────────────────
        print("[Asset Pipeline] Stage 5 — OCR Extraction")

        ocr_data = {}
        raw_text = ''
        ocr_method = 'none'

        if AI_AVAILABLE and reader:
            try:
                ocr_items = reader.readtext(doc_path)
                raw_text = ' '.join([item[1] for item in ocr_items])
                ocr_data = extract_asset_info(raw_text)
                ocr_method = 'EasyOCR'
                fields_found = sum(1 for v in ocr_data.values() if v)
                print(f"[Asset Pipeline] Stage 5 DONE — {fields_found}/7 fields extracted")
            except Exception as ocr_err:
                print(f"[Asset Pipeline] Stage 5 OCR failed: {ocr_err}")
                ocr_data = {k: None for k in [
                    'ownerName', 'propertyNumber', 'registrationNumber', 
                    'governmentAuthority', 'propertyAddress', 'marketValue', 'documentDate'
                ]}
                ocr_method = 'failed'
        else:
            # Mock OCR output
            ocr_data = {
                'ownerName': 'John Doe',
                'propertyNumber': 'PROP-12345',
                'registrationNumber': 'REG-67890',
                'governmentAuthority': 'Land Registry',
                'propertyAddress': '123 Main Street',
                'marketValue': '500000',
                'documentDate': '2020-01-15'
            }
            ocr_method = 'mock'

        pipeline_result['stages']['stage5_ocr'] = {
            'extractedData': ocr_data,
            'rawText': raw_text,
            'ocrMethod': ocr_method
        }

        # ── STAGE 6: Risk Analysis & Decision ────────────────────────────────
        print("[Asset Pipeline] Stage 6 — Risk Analysis")

        # Note: Duplicate check is done by Node.js backend, we assume not duplicate here
        is_duplicate = False
        risk_result = run_asset_risk_analysis(doc_clarity, ai_gen_result, manipulation_result, ocr_data, is_duplicate)
        pipeline_result['stages']['stage6_risk'] = risk_result

        pipeline_result['success'] = True
        pipeline_result['finalDecision'] = risk_result['decision']

        print(f"[Asset Pipeline] COMPLETE — riskScore={risk_result['riskScore']} decision={risk_result['decision']}")

        # Upload processed image to Cloudinary
        doc_cloud = upload_document(doc_path, 'asset-pipeline-docs')

        pipeline_result['documentUrl'] = doc_cloud.get('url') if doc_cloud.get('success') else None

        return jsonify(pipeline_result), 200

    except Exception as e:
        print(f"[Asset Pipeline] Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        _cleanup([doc_path])
        return jsonify({
            'error': f'Pipeline error: {str(e)}',
            'success': False
        }), 500


# =============================================================================
# KYC VERIFICATION PIPELINE
# POST /pipeline/verify  —  runs all 4 stages sequentially in a single call
# =============================================================================

@app.route('/pipeline/verify', methods=['POST'])
def pipeline_verify():
    """
    Full KYC verification pipeline.

    Multipart form fields required:
        document  — ID card image (png/jpg/jpeg/pdf)
        selfie    — Live selfie photo

    Pipeline stages (sequential, fail-fast on Stage 1 failure):
        Stage 1: Image clarity check — document AND selfie
        Stage 2: National ID OCR extraction
        Stage 3: Face similarity detection (selfie vs. document face)
        Stage 4: Risk analysis & final decision

    Response structure:
    {
      "success":         bool,
      "pipelineVersion": "1.0.0",
      "finalDecision":   "approved" | "under_review" | "rejected",
      "abortedAt":       null | "stage1_clarity",
      "abortReason":     null | string,
      "stages": {
        "stage1_clarity": {
          "passed": bool,
          "document": { passed, qualityScore, issues, details },
          "selfie":   { passed, qualityScore, issues, details }
        },
        "stage2_ocr": {
          "extractedData": { fullName, idNumber, dateOfBirth, sex, address, dateOfIssue, placeOfBirth },
          "rawText":        string,
          "ocrMethod":      string
        },
        "stage3_face": {
          "similarityScore": float,
          "match":           bool,
          "confidence":      "high" | "medium" | "low",
          "distance":        float
        },
        "stage4_risk": {
          "riskScore":  float (0-100),
          "riskLevel":  "low" | "medium" | "high",
          "decision":   "approved" | "under_review" | "rejected",
          "factors":    { documentClarity, selfieClarity, ocrCompleteness, faceSimilarity, documentAuthenticity }
        }
      },
      "documentUrl": string | null,
      "selfieUrl":   string | null
    }
    """
    if 'document' not in request.files or 'selfie' not in request.files:
        return jsonify({
            'error': 'Both "document" and "selfie" files are required'
        }), 400

    document_file = request.files['document']
    selfie_file = request.files['selfie']

    if document_file.filename == '' or selfie_file.filename == '':
        return jsonify({'error': 'No file selected for document or selfie'}), 400

    if not (allowed_file(document_file.filename) and allowed_file(selfie_file.filename)):
        return jsonify({'error': 'Invalid file type. Allowed: png, jpg, jpeg, pdf'}), 400

    # Save uploaded files to disk for AI processing
    doc_filename = secure_filename(str(uuid.uuid4()) + '_pipeline_doc_' + document_file.filename)
    selfie_filename = secure_filename(str(uuid.uuid4()) + '_pipeline_selfie_' + selfie_file.filename)

    doc_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], doc_filename))
    selfie_path = os.path.abspath(os.path.join(app.config['UPLOAD_FOLDER'], selfie_filename))

    document_file.save(doc_path)
    selfie_file.save(selfie_path)

    pipeline_result = {
        'success': False,
        'pipelineVersion': '1.0.0',
        'finalDecision': None,
        'abortedAt': None,
        'abortReason': None,
        'stages': {
            'stage1_clarity': None,
            'stage2_ocr': None,
            'stage3_face': None,
            'stage4_risk': None
        },
        'documentUrl': None,
        'selfieUrl': None
    }

    try:
        # ── STAGE 1: Image Clarity Check ─────────────────────────────────────
        print("[KYC Pipeline] Stage 1 — Image Clarity Check")

        if AI_AVAILABLE:
            doc_clarity = check_image_clarity(doc_path)
            selfie_clarity = check_image_clarity(selfie_path)
        else:
            # Mock mode fallback
            doc_clarity = {'passed': True, 'qualityScore': 0.92, 'issues': [], 'details': {}}
            selfie_clarity = {'passed': True, 'qualityScore': 0.88, 'issues': [], 'details': {}}

        stage1_result = {
            'passed': doc_clarity['passed'] and selfie_clarity['passed'],
            'document': doc_clarity,
            'selfie': selfie_clarity
        }
        pipeline_result['stages']['stage1_clarity'] = stage1_result

        # Fail-fast: abort if document image is critically unusable
        if not doc_clarity['passed']:
            pipeline_result['abortedAt'] = 'stage1_clarity'
            pipeline_result['abortReason'] = (
                'Document image failed clarity check: ' + ', '.join(doc_clarity['issues'])
            )
            pipeline_result['finalDecision'] = 'rejected'
            _cleanup([doc_path, selfie_path])
            return jsonify(pipeline_result), 200

        if not selfie_clarity['passed']:
            pipeline_result['abortedAt'] = 'stage1_clarity'
            pipeline_result['abortReason'] = (
                'Selfie image failed clarity check: ' + ', '.join(selfie_clarity['issues'])
            )
            pipeline_result['finalDecision'] = 'rejected'
            _cleanup([doc_path, selfie_path])
            return jsonify(pipeline_result), 200

        print(f"[KYC Pipeline] Stage 1 PASSED — doc={doc_clarity['qualityScore']} selfie={selfie_clarity['qualityScore']}")

        # ── STAGE 2: National ID OCR Extraction ──────────────────────────────
        print("[KYC Pipeline] Stage 2 — National ID OCR Extraction")

        ocr_data = {}
        raw_text = ''
        ocr_method = 'none'

        if AI_AVAILABLE and reader:
            try:
                ocr_items = reader.readtext(doc_path)
                raw_text = ' '.join([item[1] for item in ocr_items])
                ocr_data = extract_id_info(raw_text)
                ocr_method = 'EasyOCR'
                fields_found = sum(1 for v in ocr_data.values() if v)
                print(f"[KYC Pipeline] Stage 2 DONE — {fields_found}/7 fields extracted")
            except Exception as ocr_err:
                print(f"[KYC Pipeline] Stage 2 OCR failed: {ocr_err}")
                ocr_data = {k: None for k in [
                    'fullName', 'idNumber', 'dateOfBirth', 'sex', 'address', 'dateOfIssue', 'placeOfBirth'
                ]}
                ocr_method = 'failed'
        else:
            # Mock OCR output
            ocr_data = {
                'fullName': 'John Doe',
                'idNumber': '123456789V',
                'dateOfBirth': '1990-01-01',
                'sex': 'Male',
                'address': '123 Main Street, Colombo',
                'dateOfIssue': '2018-01-15',
                'placeOfBirth': 'Colombo'
            }
            ocr_method = 'mock'

        pipeline_result['stages']['stage2_ocr'] = {
            'extractedData': ocr_data,
            'rawText': raw_text,
            'ocrMethod': ocr_method
        }

        # ── STAGE 3: Face Similarity Detection ───────────────────────────────
        print("[KYC Pipeline] Stage 3 — Face Similarity Detection")

        face_data = {}

        if AI_AVAILABLE:
            try:
                verification = DeepFace.verify(
                    img1_path=selfie_path,
                    img2_path=doc_path,
                    model_name='VGG-Face',
                    detector_backend='retinaface',
                    enforce_detection=False
                )
                distance = verification.get('distance', 1.0)
                similarity_pct = round(max(0.0, min(100.0, (1 - distance) * 100)), 2)
                match = verification.get('verified', False)

                if similarity_pct >= 80:
                    confidence = 'high'
                elif similarity_pct >= 60:
                    confidence = 'medium'
                else:
                    confidence = 'low'

                face_data = {
                    'similarityScore': similarity_pct,
                    'match': match,
                    'confidence': confidence,
                    'distance': round(distance, 4)
                }
                print(f"[KYC Pipeline] Stage 3 DONE — similarity={similarity_pct}% match={match}")
            except Exception as face_err:
                print(f"[KYC Pipeline] Stage 3 face verification failed: {face_err}")
                face_data = {
                    'similarityScore': 0.0,
                    'match': False,
                    'confidence': 'low',
                    'distance': 1.0,
                    'error': str(face_err)
                }
        else:
            # Mock face result
            face_data = {
                'similarityScore': 95.5,
                'match': True,
                'confidence': 'high',
                'distance': 0.045
            }

        pipeline_result['stages']['stage3_face'] = face_data

        # ── STAGE 4: Risk Analysis & Decision ────────────────────────────────
        print("[KYC Pipeline] Stage 4 — Risk Analysis")

        risk_result = run_risk_analysis(doc_clarity, selfie_clarity, ocr_data, face_data)
        pipeline_result['stages']['stage4_risk'] = risk_result

        pipeline_result['success'] = True
        pipeline_result['finalDecision'] = risk_result['decision']

        print(f"[KYC Pipeline] COMPLETE — riskScore={risk_result['riskScore']} decision={risk_result['decision']}")

        # Upload processed images to Cloudinary
        doc_cloud = upload_image(doc_path, 'kyc-pipeline-docs')
        selfie_cloud = upload_image(selfie_path, 'kyc-pipeline-selfies')

        pipeline_result['documentUrl'] = doc_cloud.get('url') if doc_cloud.get('success') else None
        pipeline_result['selfieUrl'] = selfie_cloud.get('url') if selfie_cloud.get('success') else None

        return jsonify(pipeline_result), 200

    except Exception as e:
        print(f"[KYC Pipeline] Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        _cleanup([doc_path, selfie_path])
        return jsonify({
            'error': f'Pipeline error: {str(e)}',
            'success': False
        }), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5002, debug=True)
