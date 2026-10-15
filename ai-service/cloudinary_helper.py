import os
import cloudinary
import cloudinary.uploader

# Configure Cloudinary with direct credentials
# TODO: Move these to environment variables once dotenv configuration is fixed
cloudinary.config(
    cloud_name='anzynni7',
    api_key='964512946627428',
    api_secret='dceuoiUGRGa7eDbTXKsIDzlZQsA'
)

print('Cloudinary configured with cloud name: anzynni7')

def upload_to_cloudinary(file_path, folder='ai-processed', resource_type='auto'):
    """
    Upload a file to Cloudinary
    
    Args:
        file_path (str): Local path to the file
        folder (str): Cloudinary folder name
        resource_type (str): Resource type (auto, image, raw, video)
    
    Returns:
        dict: Cloudinary upload result with URL and public_id
    """
    try:
        result = cloudinary.uploader.upload(
            file_path,
            folder=folder,
            resource_type=resource_type
        )
        
        # Delete local file after successful upload
        if os.path.exists(file_path):
            os.remove(file_path)
        
        return {
            'success': True,
            'url': result.get('secure_url'),
            'public_id': result.get('public_id'),
            'resource_type': result.get('resource_type')
        }
    except Exception as e:
        print(f"Cloudinary upload error: {e}")
        return {
            'success': False,
            'error': str(e)
        }

def upload_image(file_path, folder='ai-images'):
    """
    Upload an image to Cloudinary
    
    Args:
        file_path (str): Local path to the image file
        folder (str): Cloudinary folder name
    
    Returns:
        dict: Cloudinary upload result
    """
    return upload_to_cloudinary(file_path, folder, resource_type='image')

def upload_document(file_path, folder='ai-documents'):
    """
    Upload a document to Cloudinary
    
    Args:
        file_path (str): Local path to the document file
        folder (str): Cloudinary folder name
    
    Returns:
        dict: Cloudinary upload result
    """
    return upload_to_cloudinary(file_path, folder, resource_type='auto')

def delete_from_cloudinary(public_id):
    """
    Delete a file from Cloudinary
    
    Args:
        public_id (str): Cloudinary public ID
    
    Returns:
        dict: Cloudinary deletion result
    """
    try:
        result = cloudinary.uploader.destroy(public_id)
        return {
            'success': True,
            'result': result
        }
    except Exception as e:
        print(f"Cloudinary deletion error: {e}")
        return {
            'success': False,
            'error': str(e)
        }